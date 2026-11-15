/**
 * Controle de Gastos — Backend (Google Apps Script, gratuito)
 *
 * Expõe uma API JSON (Web App) que:
 *   - mantém listas de compras, uma aba por data no formato "aaaammdd";
 *   - cria listas a partir da aba "modelo" (itens semanais, quinzenais, mensais, demanda);
 *   - consulta a NFC-e na SEFAZ a partir do link do QR Code, grava os itens na aba "Compras"
 *     e copia/concilia a compra na aba "aaaammdd" da data da compra;
 *   - registra erros de importação na aba "Log".
 *
 * Instalação: veja README.md (rodar setup() uma vez e implantar como App da Web).
 */

const SPREADSHEET_ID = '1FyjzkPfp0D40FAzETEM7JQ_-I2CSNiSFO-_7gHgxmp4';
const FUSO = 'America/Sao_Paulo';

const ABAS = {
  COMPRAS: {
    nome: 'Compras',
    cab: ['ChaveNFCe', 'DataEmissao', 'Estabelecimento', 'Descricao', 'Quantidade', 'Unidade',
          'ValorUnitario', 'TotalNota'],
  },
  MODELO: { nome: 'modelo', cab: ['Item', 'Quantidade', 'Unidade', 'Frequencia'] },
  LOG:    { nome: 'Log', cab: ['DataHora', 'Acao', 'Chave', 'Erro', 'Detalhe', 'Url'] },
};

/** Layout antigo da aba Compras (v1), convertido automaticamente para o novo. */
const CAB_COMPRAS_V1 = ['ChaveNFCe', 'DataEmissao', 'Estabelecimento', 'CNPJ', 'Codigo', 'Descricao',
  'Quantidade', 'Unidade', 'ValorUnitario', 'ValorTotalItem', 'TotalNota', 'UrlConsulta', 'ImportadoEm'];

/** Colunas de cada aba de lista "aaaammdd". */
const CAB_LISTA = ['ID', 'Item', 'Quantidade', 'Unidade', 'Frequencia', 'Origem', 'Status', 'CriadoEm',
  'CompradoEm', 'DescricaoNFCe', 'QtdComprada', 'ValorUnitario', 'ChaveNFCe'];
const C = {};
CAB_LISTA.forEach((h, i) => (C[h] = i + 1)); // índice de coluna (1-based)

const CAMPOS_EDITAVEIS = { item: C.Item, quantidade: C.Quantidade, unidade: C.Unidade,
                           frequencia: C.Frequencia, status: C.Status };
const FREQUENCIAS = ['Semanal', 'Quinzenal', 'Mensal', 'Demanda'];
const RE_LISTA = /^\d{8}$/;
const FORMATO_VALOR = '0.00'; // exibe NN,NN numa planilha com localidade Brasil

/* ============================== Instalação ============================== */

/** Rode UMA vez pelo editor: cria as abas fixas e gera o token de acesso. */
function setup() {
  const ss = ss_();
  Object.keys(ABAS).forEach(k => aba_(ss, ABAS[k]));
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('API_TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('API_TOKEN', token);
  }
  Logger.log('Token de acesso (cole na tela Config do app): ' + token);
}

/** Gera um token novo (invalida o anterior). */
function trocarToken() {
  PropertiesService.getScriptProperties().deleteProperty('API_TOKEN');
  setup();
}

/* ================================ HTTP ================================== */

function doGet() {
  return json_({ ok: true, data: { msg: 'API Controle de Gastos online. Use POST.' } });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'JSON inválido' });
  }
  try {
    autenticar_(req.token);
    const acao = ACOES[req.action];
    if (!acao) throw new Error('Ação desconhecida: ' + req.action);
    return json_({ ok: true, data: acao(req) });
  } catch (err) {
    return json_({ ok: false, error: (err && err.message) || String(err) });
  }
}

const ACOES = {
  ping:             ()  => ({ versao: 2, hora: new Date().toISOString() }),
  listarListas:     ()  => listarListas_(),
  resumoModelo:     ()  => resumoModelo_(),
  criarLista:       req => comLock_(() => criarLista_(req.data, req.frequencias)),
  listarItens:      req => lerItensAba_(abaLista_(ss_(), req.lista, false)),
  adicionarItem:    req => comLock_(() => adicionarItem_(req.lista, req.item || {})),
  atualizarItem:    req => comLock_(() => atualizarItem_(req.lista, req.id, req.campos || {})),
  removerItem:      req => comLock_(() => removerItem_(req.lista, req.id)),
  removerComprados: req => comLock_(() => removerComprados_(req.lista)),
  importarNfce:     req => comLock_(() => importarNfce_(req.url, req.html)),
  listarCompras:    req => listarCompras_(Number(req.limite) || 50),
  detalharCompra:   req => detalharCompra_(String(req.chave || '')),
};

function autenticar_(token) {
  const esperado = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!esperado) throw new Error('Backend não configurado: execute setup() no editor do Apps Script.');
  if (!token || String(token) !== esperado) throw new Error('Token inválido.');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function comLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ============================ Planilha util ============================= */

function ss_() { return SpreadsheetApp.openById(SPREADSHEET_ID); }

function escreverCab_(sh, cab) {
  sh.getRange(1, 1, 1, cab.length).setValues([cab]).setFontWeight('bold');
  sh.setFrozenRows(1);
}

function aba_(ss, def) {
  let sh = ss.getSheetByName(def.nome);
  if (!sh) sh = ss.insertSheet(def.nome);
  if (sh.getLastRow() === 0) {
    escreverCab_(sh, def.cab);
    if (def === ABAS.COMPRAS) formatarCompras_(sh, 2, sh.getMaxRows() - 1);
    return sh;
  }
  if (def === ABAS.COMPRAS) migrarCompras_(sh);
  return sh;
}

function formatarCompras_(sh, linha, qtd) {
  if (qtd < 1) return;
  sh.getRange(linha, 1, qtd, 1).setNumberFormat('@');               // chave de 44 dígitos como texto
  sh.getRange(linha, 2, qtd, 1).setNumberFormat('dd/MM/yyyy HH:mm');
  sh.getRange(linha, 7, qtd, 2).setNumberFormat(FORMATO_VALOR);     // ValorUnitario e TotalNota
}

/** Converte a aba Compras do layout antigo para o novo, preservando os dados. */
function migrarCompras_(sh) {
  const larg = sh.getLastColumn();
  const cab = sh.getRange(1, 1, 1, larg).getValues()[0].map(String);
  if (cab.slice(0, ABAS.COMPRAS.cab.length).join('|') === ABAS.COMPRAS.cab.join('|')) return;
  if (cab.join('|') !== CAB_COMPRAS_V1.join('|')) {
    throw new Error('A aba Compras tem colunas inesperadas. Esperado: ' + ABAS.COMPRAS.cab.join(', '));
  }
  const n = sh.getLastRow();
  const dados = n > 1 ? sh.getRange(2, 1, n - 1, larg).getValues() : [];
  const idx = ABAS.COMPRAS.cab.map(h => cab.indexOf(h));
  const novos = dados.map(r => idx.map(i => r[i]));
  sh.clear();
  escreverCab_(sh, ABAS.COMPRAS.cab);
  formatarCompras_(sh, 2, sh.getMaxRows() - 1);
  if (novos.length) sh.getRange(2, 1, novos.length, novos[0].length).setValues(novos);
  log_('migracao', '', 'Aba Compras convertida para o novo layout', novos.length + ' linha(s)', '');
}

function iso_(v) { return v instanceof Date ? v.toISOString() : (v || ''); }

function hoje_() { return Utilities.formatDate(new Date(), FUSO, 'yyyyMMdd'); }

function linhaPorId_(sh, id) {
  const n = sh.getLastRow();
  if (n < 2 || !id) return -1;
  const ids = sh.getRange(2, 1, n - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return -1;
}

/* ================================= Log ================================== */

function log_(acao, chave, erro, detalhe, url) {
  try {
    const sh = aba_(ss_(), ABAS.LOG);
    sh.appendRow([new Date(), acao, chave ? "'" + chave : '', erro || '', detalhe || '', url || '']);
  } catch (e) {
    console.error('Falha ao gravar log: ' + e);
  }
  console.error('[' + acao + '] ' + erro + (detalhe ? ' | ' + detalhe : ''));
}

/* ========================= Listas (abas aaaammdd) ======================= */

function nomeLista_(s) {
  s = String(s || '').replace(/\D/g, '');
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) {
    throw new Error('Data da lista inválida (use aaaammdd).');
  }
  return s;
}

function abaLista_(ss, nome, criar) {
  nome = nomeLista_(nome);
  let sh = ss.getSheetByName(nome);
  if (sh) return sh;
  if (!criar) throw new Error('A lista ' + nome + ' não existe.');
  sh = ss.insertSheet(nome);
  escreverCab_(sh, CAB_LISTA);
  const linhas = sh.getMaxRows() - 1;
  sh.getRange(2, C.CriadoEm, linhas, 2).setNumberFormat('dd/MM/yyyy HH:mm');
  sh.getRange(2, C.ValorUnitario, linhas, 1).setNumberFormat(FORMATO_VALOR);
  sh.getRange(2, C.ChaveNFCe, linhas, 1).setNumberFormat('@');
  return sh;
}

function listarListas_() {
  return ss_().getSheets().map(s => s.getName()).filter(n => RE_LISTA.test(n)).sort().reverse();
}

function linhaLista_(o, agora) {
  const r = new Array(CAB_LISTA.length).fill('');
  r[0] = Utilities.getUuid();
  r[C.Item - 1] = o.item;
  r[C.Quantidade - 1] = Number(o.quantidade) || 1;
  r[C.Unidade - 1] = o.unidade || '';
  r[C.Frequencia - 1] = o.frequencia || '';
  r[C.Origem - 1] = o.origem || 'Manual';
  r[C.Status - 1] = o.status || 'Pendente';
  r[C.CriadoEm - 1] = agora;
  return r;
}

function objLista_(r) {
  return {
    id: r[0], item: r[C.Item - 1], quantidade: r[C.Quantidade - 1], unidade: r[C.Unidade - 1],
    frequencia: r[C.Frequencia - 1], origem: r[C.Origem - 1], status: r[C.Status - 1] || 'Pendente',
    criadoEm: iso_(r[C.CriadoEm - 1]), compradoEm: iso_(r[C.CompradoEm - 1]),
    descricaoNfce: r[C.DescricaoNFCe - 1], qtdComprada: r[C.QtdComprada - 1],
    valorUnitario: r[C.ValorUnitario - 1], chave: String(r[C.ChaveNFCe - 1] || ''),
  };
}

function lerItensAba_(sh) {
  const n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, CAB_LISTA.length).getValues().filter(r => r[0]).map(objLista_);
}

/**
 * Cria a aba "aaaammdd" (se não existir) e, opcionalmente, inclui os itens da aba "modelo"
 * das frequências escolhidas. Itens já presentes na lista não são duplicados.
 */
function criarLista_(data, frequencias) {
  const ss = ss_();
  const nome = nomeLista_(data || hoje_());
  const existia = !!ss.getSheetByName(nome);
  const sh = abaLista_(ss, nome, true);

  const freqs = (frequencias || []).map(normFreq_).filter(Boolean);
  let adicionados = 0;
  if (freqs.length) {
    const presentes = {};
    lerItensAba_(sh).forEach(i => (presentes[normalizar_(i.item)] = true));
    const agora = new Date();
    const linhas = [];
    lerModelo_(ss).forEach(m => {
      const k = normalizar_(m.item);
      if (freqs.indexOf(m.frequencia) < 0 || presentes[k]) return;
      presentes[k] = true;
      linhas.push(linhaLista_({ item: m.item, quantidade: m.quantidade, unidade: m.unidade,
                                frequencia: m.frequencia, origem: 'Modelo' }, agora));
    });
    if (linhas.length) sh.getRange(sh.getLastRow() + 1, 1, linhas.length, CAB_LISTA.length).setValues(linhas);
    adicionados = linhas.length;
  }
  return { nome: nome, criada: !existia, adicionados: adicionados };
}

function adicionarItem_(lista, item) {
  const nome = String(item.item || '').trim();
  if (!nome) throw new Error('Informe o nome do item.');
  const sh = abaLista_(ss_(), lista, false);
  const r = linhaLista_({ item: nome, quantidade: item.quantidade, unidade: String(item.unidade || '').trim(),
                          frequencia: normFreq_(item.frequencia), origem: 'Manual' }, new Date());
  sh.getRange(sh.getLastRow() + 1, 1, 1, r.length).setValues([r]);
  return objLista_(r);
}

function atualizarItem_(lista, id, campos) {
  const sh = abaLista_(ss_(), lista, false);
  const linha = linhaPorId_(sh, id);
  if (linha < 0) throw new Error('Item não encontrado.');
  Object.keys(campos).forEach(k => {
    if (CAMPOS_EDITAVEIS[k]) sh.getRange(linha, CAMPOS_EDITAVEIS[k]).setValue(campos[k]);
  });
  if (campos.status) {
    sh.getRange(linha, C.CompradoEm).setValue(campos.status === 'Comprado' ? new Date() : '');
  }
  return { id: id };
}

function removerItem_(lista, id) {
  const sh = abaLista_(ss_(), lista, false);
  const linha = linhaPorId_(sh, id);
  if (linha > 0) sh.deleteRow(linha);
  return { id: id };
}

function removerComprados_(lista) {
  const sh = abaLista_(ss_(), lista, false);
  const n = sh.getLastRow();
  if (n < 2) return { removidos: 0 };
  const st = sh.getRange(2, C.Status, n - 1, 1).getValues();
  let removidos = 0;
  for (let i = st.length - 1; i >= 0; i--) {
    if (st[i][0] === 'Comprado') { sh.deleteRow(i + 2); removidos++; }
  }
  return { removidos: removidos };
}

/* ================================ Modelo ================================ */

function normFreq_(s) {
  const n = normalizar_(s);
  if (n.indexOf('sem') === 0) return 'Semanal';
  if (n.indexOf('quin') === 0) return 'Quinzenal';
  if (n.indexOf('men') === 0) return 'Mensal';
  if (n.indexOf('dem') === 0 || n.indexOf('sob') === 0) return 'Demanda';
  return '';
}

/** Lê a aba "modelo" localizando as colunas pelo nome do cabeçalho (sem diferenciar acentos/caixa). */
function lerModelo_(ss) {
  const sh = ss.getSheets().filter(s => s.getName().trim().toLowerCase() === 'modelo')[0];
  if (!sh || sh.getLastRow() < 2) return [];
  const vals = sh.getDataRange().getValues();
  const cab = vals[0].map(normalizar_);
  const col = nomes => cab.findIndex(h => nomes.some(n => h === n || h.indexOf(n) === 0));
  let ci = col(['item', 'produto', 'descricao']);
  if (ci < 0) ci = 0;
  const cq = col(['quantidade', 'qtd', 'qtde']);
  const cu = col(['unidade', 'un']);
  const cf = col(['frequencia', 'periodicidade', 'recorrencia', 'tipo']);
  return vals.slice(1)
    .filter(r => String(r[ci] || '').trim())
    .map(r => ({
      item: String(r[ci]).trim(),
      quantidade: cq >= 0 ? Number(r[cq]) || 1 : 1,
      unidade: cu >= 0 ? String(r[cu] || '').trim() : '',
      frequencia: cf >= 0 ? normFreq_(r[cf]) : '',
    }));
}

function resumoModelo_() {
  const itens = lerModelo_(ss_());
  const cont = {};
  FREQUENCIAS.forEach(f => (cont[f] = 0));
  itens.forEach(i => { if (cont[i.frequencia] !== undefined) cont[i.frequencia]++; });
  return { total: itens.length, porFrequencia: cont };
}

/* ================================ NFC-e ================================= */

/** Importa a nota; qualquer falha é registrada na aba Log antes de voltar ao app. */
function importarNfce_(url, htmlManual) {
  url = String(url || '').trim();
  try {
    return importar_(url, htmlManual);
  } catch (err) {
    log_('importarNfce' + (htmlManual ? ' (HTML manual)' : ''), extrairChave_('', url),
         (err && err.message) || String(err), err && err.detalhe, url);
    throw err;
  }
}

function importar_(url, htmlManual) {
  let html = htmlManual ? String(htmlManual) : '';
  let http = 'manual';
  if (!html) {
    if (!/^https?:\/\//i.test(url)) throw new Error('Link da NFC-e inválido (precisa começar com http).');
    const r = baixar_(url);
    html = r.html;
    http = r.codigo;
  }

  const nota = parseNfce_(html, url);
  if (!nota.itens.length) {
    const e = new Error('Não consegui ler os itens desta NFC-e. A página da SEFAZ pode estar fora do ar, ' +
      'exigir captcha ou usar um layout ainda não suportado. Tente a importação manual (HTML).');
    e.detalhe = 'HTTP ' + http + '; título: "' + texto_(pegar_(html, /<title[^>]*>([\s\S]*?)<\/title>/i)).slice(0, 120) +
      '"; tamanho: ' + html.length + ' caracteres; início: ' + texto_(html).slice(0, 300);
    throw e;
  }

  const ss = ss_();
  const sh = aba_(ss, ABAS.COMPRAS);
  if (nota.chave && chaveExiste_(sh, nota.chave)) {
    return { duplicada: true, nota: resumoNota_(nota), itens: nota.itens, marcados: [], foraDaLista: 0, lista: null };
  }

  const linhas = nota.itens.map(it => [
    nota.chave, nota.dataEmissao || '', nota.estabelecimento, it.descricao,
    it.quantidade, it.unidade, it.valorUnitario, nota.total,
  ]);
  const inicio = sh.getLastRow() + 1;
  formatarCompras_(sh, inicio, linhas.length);
  sh.getRange(inicio, 1, linhas.length, linhas[0].length).setValues(linhas);

  const conc = copiarParaLista_(ss, nota);
  return { duplicada: false, nota: resumoNota_(nota), itens: nota.itens,
           marcados: conc.marcados, foraDaLista: conc.extras, lista: conc.nome };
}

/**
 * Copia a compra para a aba "aaaammdd" da data da compra (criando-a se preciso):
 *  - itens da lista que casam com produtos da nota recebem descrição, qtd, valor e chave, e viram "Comprado";
 *  - produtos da nota que não estavam na lista entram como linhas novas (Origem = "NFC-e").
 */
function copiarParaLista_(ss, nota) {
  const nome = Utilities.formatDate(nota.dataEmissao || new Date(), FUSO, 'yyyyMMdd');
  const sh = abaLista_(ss, nome, true);
  const compradoEm = nota.dataEmissao || new Date();
  const descs = nota.itens.map(it => ' ' + normalizar_(it.descricao) + ' ');
  const usados = nota.itens.map(() => false);
  const marcados = [];

  const n = sh.getLastRow();
  const vals = n > 1 ? sh.getRange(2, 1, n - 1, CAB_LISTA.length).getValues() : [];
  vals.forEach((r, i) => {
    if (!r[0] || r[C.ChaveNFCe - 1]) return; // já conciliado com outra nota
    const palavras = normalizar_(r[C.Item - 1]).split(' ').filter(p => p.length >= 3);
    if (!palavras.length) return;
    const j = descs.findIndex((d, k) => !usados[k] && palavras.every(p => d.indexOf(' ' + p) >= 0));
    if (j < 0) return;
    usados[j] = true;
    const it = nota.itens[j];
    // Colunas Status..ChaveNFCe são contíguas: grava só esse trecho da linha.
    sh.getRange(i + 2, C.Status, 1, C.ChaveNFCe - C.Status + 1).setValues([[
      'Comprado', r[C.CriadoEm - 1], compradoEm, it.descricao, it.quantidade, it.valorUnitario, nota.chave,
    ]]);
    marcados.push(r[C.Item - 1]);
  });

  const agora = new Date();
  const extras = [];
  nota.itens.forEach((it, k) => {
    if (usados[k]) return;
    const r = linhaLista_({ item: it.descricao, quantidade: it.quantidade, unidade: it.unidade,
                            origem: 'NFC-e', status: 'Comprado' }, agora);
    r[C.CompradoEm - 1] = compradoEm;
    r[C.DescricaoNFCe - 1] = it.descricao;
    r[C.QtdComprada - 1] = it.quantidade;
    r[C.ValorUnitario - 1] = it.valorUnitario;
    r[C.ChaveNFCe - 1] = nota.chave;
    extras.push(r);
  });
  if (extras.length) sh.getRange(sh.getLastRow() + 1, 1, extras.length, CAB_LISTA.length).setValues(extras);

  return { nome: nome, marcados: marcados, extras: extras.length };
}

function resumoNota_(n) {
  return { chave: n.chave, estabelecimento: n.estabelecimento, cnpj: n.cnpj,
           dataEmissao: iso_(n.dataEmissao), total: n.total, qtdItens: n.itens.length };
}

function chaveExiste_(sh, chave) {
  const n = sh.getLastRow();
  if (n < 2) return false;
  return sh.getRange(2, 1, n - 1, 1).getValues().some(r => String(r[0]) === chave);
}

function baixar_(url) {
  let resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      followRedirects: true,
      muteHttpExceptions: true,
      validateHttpsCertificates: false, // alguns portais SEFAZ têm cadeia de certificados incompleta
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
    });
  } catch (err) {
    const e = new Error('Não foi possível acessar o portal da SEFAZ.');
    e.detalhe = String(err && err.message || err);
    throw e;
  }
  const codigo = resp.getResponseCode();
  if (codigo >= 400) {
    const e = new Error('A SEFAZ respondeu HTTP ' + codigo + ' ao consultar a nota.');
    e.detalhe = texto_(resp.getContentText()).slice(0, 300);
    throw e;
  }
  const tipo = String(resp.getHeaders()['Content-Type'] || resp.getHeaders()['content-type'] || '');
  let html;
  if (/charset=/i.test(tipo)) html = resp.getContentText();
  else {
    const bruto = resp.getContentText('UTF-8');
    html = /charset=["']?(iso-8859-1|windows-1252)/i.test(bruto) ? resp.getContentText('ISO-8859-1') : bruto;
  }
  return { html: html, codigo: codigo };
}

/**
 * Parsers por layout. O "padrão" cobre o portal de consulta usado pela maioria das SEFAZ
 * (SP, RS/SVRS, PR, BA, GO, PE, ES, DF, SC...). Para outro estado, crie uma função que
 * receba (html, url) e devolva a nota, e adicione-a nesta lista.
 */
const PARSERS = [parserPadraoSefaz_];

function parseNfce_(html, url) {
  for (let i = 0; i < PARSERS.length; i++) {
    const nota = PARSERS[i](html, url);
    if (nota && nota.itens.length) return nota;
  }
  return { chave: extrairChave_(html, url), estabelecimento: '', cnpj: '', dataEmissao: null, total: 0, itens: [] };
}

function parserPadraoSefaz_(html, url) {
  const txt = texto_(html);
  const nota = {
    chave: extrairChave_(html, url),
    estabelecimento: texto_(pegar_(html, /<div[^>]*id=["']u20["'][^>]*>([\s\S]*?)<\/div>/i)),
    cnpj: '', dataEmissao: null, total: 0, itens: [],
  };

  const cnpj = txt.match(/CNPJ\s*:?\s*(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})/i);
  if (cnpj) nota.cnpj = cnpj[1];

  const em = txt.match(/Emiss[ãa]o\s*:?\s*(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/i);
  if (em) nota.dataEmissao = new Date(+em[3], +em[2] - 1, +em[1], +(em[4] || 0), +(em[5] || 0), +(em[6] || 0));

  const blocos = html.split(/<tr[^>]*id=["']Item[^"']*["'][^>]*>/i).slice(1);
  blocos.forEach(b => {
    b = b.split(/<\/tr>/i)[0];
    const descricao = texto_(pegar_(b, /<span[^>]*class=["']txtTit2?["'][^>]*>([\s\S]*?)<\/span>/i));
    if (!descricao) return;
    const cod = texto_(pegar_(b, /class=["']RCod["'][^>]*>([\s\S]*?)<\/span>/i)).match(/C[óo]digo\s*:?\s*([^\s)]+)/i);
    nota.itens.push({
      codigo: cod ? cod[1] : '',
      descricao: descricao,
      quantidade: num_(texto_(pegar_(b, /class=["']Rqtd["'][^>]*>([\s\S]*?)<\/span>/i)).replace(/Qtde\.?\s*:?/i, '')),
      unidade: texto_(pegar_(b, /class=["']RUN["'][^>]*>([\s\S]*?)<\/span>/i)).replace(/^UN\s*:?\s*/i, ''),
      valorUnitario: num_(texto_(pegar_(b, /class=["']RvlUnit["'][^>]*>([\s\S]*?)<\/span>/i)).replace(/Vl\.?\s*Unit\.?\s*:?/i, '')),
      valorTotal: num_(texto_(pegar_(b, /class=["']valor["'][^>]*>([\s\S]*?)<\/span>/i))),
    });
  });

  const pagar = pegar_(html, /class=["']totalNumb txtMax["'][^>]*>([\s\S]*?)<\/span>/i);
  nota.total = pagar ? num_(texto_(pagar)) : 0;
  if (!nota.total) {
    const m = txt.match(/Valor a pagar\s*R?\$?\s*:?\s*([\d.,]+)/i);
    nota.total = m ? num_(m[1]) : round2_(nota.itens.reduce((s, it) => s + it.valorTotal, 0));
  }
  return nota;
}

function extrairChave_(html, url) {
  const m = String(url || '').match(/[?&](?:p|chNFe)=(\d{44})/i);
  if (m) return m[1];
  const span = texto_(pegar_(html || '', /class=["']chave["'][^>]*>([\s\S]*?)<\/span>/i)).replace(/\D/g, '');
  if (span.length === 44) return span;
  const solto = String(url || '').match(/\d{44}/);
  return solto ? solto[0] : '';
}

/* ============================ Texto / números =========================== */

function pegar_(s, re) { const m = String(s || '').match(re); return m ? m[1] : ''; }

function texto_(html) {
  return decodificar_(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

const MARCAS_ = { acute: '́', grave: '̀', circ: '̂', tilde: '̃', uml: '̈', cedil: '̧' };
const ENTIDADES_ = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ordm: 'º', ordf: 'ª', deg: '°' };

function decodificar_(s) {
  return s
    .replace(/&([A-Za-z])(acute|grave|circ|tilde|uml|cedil);/g, (_, l, m) => (l + MARCAS_[m]).normalize('NFC'))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&([a-z]+);/gi, (t, n) => (ENTIDADES_[n.toLowerCase()] !== undefined ? ENTIDADES_[n.toLowerCase()] : t));
}

function normalizar_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** "1.234,56" -> 1234.56 ; "0,385" -> 0.385 */
function num_(s) {
  s = String(s || '').replace(/[^\d,.-]/g, '');
  if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function round2_(n) { return Math.round(n * 100) / 100; }

/* ============================ Consulta compras ========================== */

function listarCompras_(limite) {
  const sh = aba_(ss_(), ABAS.COMPRAS);
  const n = sh.getLastRow();
  if (n < 2) return { notas: [], totalMes: 0, totalGeral: 0 };
  const vals = sh.getRange(2, 1, n - 1, ABAS.COMPRAS.cab.length).getValues();
  const porChave = {};
  vals.forEach(r => {
    const chave = String(r[0] || '') || (r[2] + '|' + iso_(r[1]));
    if (!porChave[chave]) {
      porChave[chave] = { chave: chave, data: r[1] instanceof Date ? r[1] : null,
                          estabelecimento: r[2], total: Number(r[7]) || 0, itens: 0 };
    }
    porChave[chave].itens++;
  });
  const notas = Object.keys(porChave).map(k => porChave[k])
    .sort((a, b) => (b.data ? b.data.getTime() : 0) - (a.data ? a.data.getTime() : 0));
  const hoje = new Date();
  let totalMes = 0, totalGeral = 0;
  notas.forEach(nt => {
    totalGeral += nt.total;
    if (nt.data && nt.data.getMonth() === hoje.getMonth() && nt.data.getFullYear() === hoje.getFullYear()) totalMes += nt.total;
  });
  return {
    notas: notas.slice(0, limite).map(nt => ({ chave: nt.chave, data: iso_(nt.data), estabelecimento: nt.estabelecimento, total: nt.total, itens: nt.itens })),
    totalMes: round2_(totalMes),
    totalGeral: round2_(totalGeral),
  };
}

function detalharCompra_(chave) {
  const sh = aba_(ss_(), ABAS.COMPRAS);
  const n = sh.getLastRow();
  if (n < 2 || !chave) return [];
  return sh.getRange(2, 1, n - 1, ABAS.COMPRAS.cab.length).getValues()
    .filter(r => String(r[0]) === chave)
    .map(r => ({ descricao: r[3], quantidade: r[4], unidade: r[5], valorUnitario: r[6],
                 valorTotal: round2_((Number(r[4]) || 0) * (Number(r[6]) || 0)) }));
}
