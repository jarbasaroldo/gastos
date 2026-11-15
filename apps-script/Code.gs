/**
 * Controle de Gastos — Backend (Google Apps Script, gratuito)
 *
 * Expõe uma API JSON (Web App) que:
 *   - mantém a lista de compras na aba "Lista";
 *   - consulta a NFC-e na SEFAZ a partir do link do QR Code, extrai os itens
 *     e grava na aba "Compras" (uma linha por item);
 *   - marca como "Comprado" os itens da lista que aparecem na nota.
 *
 * Instalação: veja README.md (rodar setup() uma vez e implantar como App da Web).
 */

const SPREADSHEET_ID = '1FyjzkPfp0D40FAzETEM7JQ_-I2CSNiSFO-_7gHgxmp4';

const ABAS = {
  LISTA: {
    nome: 'Lista',
    cab: ['ID', 'Item', 'Quantidade', 'Unidade', 'Categoria', 'Status', 'CriadoEm', 'CompradoEm'],
  },
  COMPRAS: {
    nome: 'Compras',
    cab: ['ChaveNFCe', 'DataEmissao', 'Estabelecimento', 'CNPJ', 'Codigo', 'Descricao',
          'Quantidade', 'Unidade', 'ValorUnitario', 'ValorTotalItem', 'TotalNota',
          'UrlConsulta', 'ImportadoEm'],
  },
};

const COL_LISTA = { item: 2, quantidade: 3, unidade: 4, categoria: 5, status: 6, compradoEm: 8 };

/* ============================== Instalação ============================== */

/** Rode UMA vez pelo editor: cria as abas e gera o token de acesso. */
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
  ping:             ()  => ({ versao: 1, hora: new Date().toISOString() }),
  listarItens:      ()  => lerLista_(),
  adicionarItem:    req => comLock_(() => adicionarItem_(req.item || {})),
  atualizarItem:    req => comLock_(() => atualizarItem_(req.id, req.campos || {})),
  removerItem:      req => comLock_(() => removerItem_(req.id)),
  removerComprados: ()  => comLock_(() => removerComprados_()),
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

function aba_(ss, def) {
  let sh = ss.getSheetByName(def.nome);
  if (!sh) sh = ss.insertSheet(def.nome);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, def.cab.length).setValues([def.cab]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function iso_(v) { return v instanceof Date ? v.toISOString() : (v || ''); }

function linhaPorId_(sh, id) {
  const n = sh.getLastRow();
  if (n < 2 || !id) return -1;
  const ids = sh.getRange(2, 1, n - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return -1;
}

/* ============================ Lista de compras ========================== */

function lerLista_() {
  const sh = aba_(ss_(), ABAS.LISTA);
  const n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, ABAS.LISTA.cab.length).getValues()
    .filter(r => r[0])
    .map(r => ({
      id: r[0], item: r[1], quantidade: r[2], unidade: r[3], categoria: r[4],
      status: r[5] || 'Pendente', criadoEm: iso_(r[6]), compradoEm: iso_(r[7]),
    }));
}

function adicionarItem_(item) {
  const nome = String(item.item || '').trim();
  if (!nome) throw new Error('Informe o nome do item.');
  const sh = aba_(ss_(), ABAS.LISTA);
  const novo = {
    id: Utilities.getUuid(), item: nome,
    quantidade: Number(item.quantidade) || 1,
    unidade: String(item.unidade || '').trim(),
    categoria: String(item.categoria || '').trim(),
    status: 'Pendente', criadoEm: new Date(), compradoEm: '',
  };
  sh.appendRow([novo.id, novo.item, novo.quantidade, novo.unidade, novo.categoria,
                novo.status, novo.criadoEm, novo.compradoEm]);
  novo.criadoEm = iso_(novo.criadoEm);
  return novo;
}

function atualizarItem_(id, campos) {
  const sh = aba_(ss_(), ABAS.LISTA);
  const linha = linhaPorId_(sh, id);
  if (linha < 0) throw new Error('Item não encontrado.');
  Object.keys(campos).forEach(k => {
    if (k === 'compradoEm' || !COL_LISTA[k]) return;
    sh.getRange(linha, COL_LISTA[k]).setValue(campos[k]);
  });
  if (campos.status) {
    sh.getRange(linha, COL_LISTA.compradoEm).setValue(campos.status === 'Comprado' ? new Date() : '');
  }
  return { id: id };
}

function removerItem_(id) {
  const sh = aba_(ss_(), ABAS.LISTA);
  const linha = linhaPorId_(sh, id);
  if (linha > 0) sh.deleteRow(linha);
  return { id: id };
}

function removerComprados_() {
  const sh = aba_(ss_(), ABAS.LISTA);
  const n = sh.getLastRow();
  if (n < 2) return { removidos: 0 };
  const st = sh.getRange(2, COL_LISTA.status, n - 1, 1).getValues();
  let removidos = 0;
  for (let i = st.length - 1; i >= 0; i--) {
    if (st[i][0] === 'Comprado') { sh.deleteRow(i + 2); removidos++; }
  }
  return { removidos: removidos };
}

/** Marca como Comprado os itens pendentes cujas palavras aparecem em algum produto da nota. */
function marcarComprados_(itensNota) {
  const sh = aba_(ss_(), ABAS.LISTA);
  const n = sh.getLastRow();
  if (n < 2) return [];
  const descs = itensNota.map(it => ' ' + normalizar_(it.descricao) + ' ');
  const vals = sh.getRange(2, 1, n - 1, ABAS.LISTA.cab.length).getValues();
  const marcados = [];
  const agora = new Date();
  vals.forEach((r, i) => {
    if (!r[0] || r[5] === 'Comprado') return;
    const palavras = normalizar_(r[1]).split(' ').filter(p => p.length >= 3);
    if (!palavras.length) return;
    const achou = descs.some(d => palavras.every(p => d.indexOf(' ' + p) >= 0));
    if (achou) {
      sh.getRange(i + 2, COL_LISTA.status).setValue('Comprado');
      sh.getRange(i + 2, COL_LISTA.compradoEm).setValue(agora);
      marcados.push(r[1]);
    }
  });
  return marcados;
}

function normalizar_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/* ================================ NFC-e ================================= */

function importarNfce_(url, htmlManual) {
  url = String(url || '').trim();
  let html = htmlManual ? String(htmlManual) : '';
  if (!html) {
    if (!/^https?:\/\//i.test(url)) throw new Error('Link da NFC-e inválido (precisa começar com http).');
    html = baixar_(url);
  }

  const nota = parseNfce_(html, url);
  if (!nota.itens.length) {
    throw new Error('Não consegui ler os itens desta NFC-e. A página da SEFAZ pode estar fora do ar, ' +
      'exigir captcha ou usar um layout ainda não suportado. Tente a importação manual (HTML).');
  }

  const sh = aba_(ss_(), ABAS.COMPRAS);
  if (nota.chave && chaveExiste_(sh, nota.chave)) {
    return { duplicada: true, nota: resumoNota_(nota), itens: nota.itens, marcados: [] };
  }

  const agora = new Date();
  const linhas = nota.itens.map(it => [
    nota.chave, nota.dataEmissao || '', nota.estabelecimento, nota.cnpj, it.codigo, it.descricao,
    it.quantidade, it.unidade, it.valorUnitario, it.valorTotal, nota.total, url, agora,
  ]);
  const inicio = sh.getLastRow() + 1;
  // Chave (44 dígitos) e código EAN como texto, para o Sheets não converter em número.
  sh.getRange(inicio, 1, linhas.length, 1).setNumberFormat('@');
  sh.getRange(inicio, 5, linhas.length, 1).setNumberFormat('@');
  sh.getRange(inicio, 1, linhas.length, linhas[0].length).setValues(linhas);
  sh.getRange(inicio, 9, linhas.length, 3).setNumberFormat('R$ #,##0.00');

  const marcados = marcarComprados_(nota.itens);
  return { duplicada: false, nota: resumoNota_(nota), itens: nota.itens, marcados: marcados };
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
  const resp = UrlFetchApp.fetch(url, {
    followRedirects: true,
    muteHttpExceptions: true,
    validateHttpsCertificates: false, // alguns portais SEFAZ têm cadeia de certificados incompleta
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
  });
  const code = resp.getResponseCode();
  if (code >= 400) throw new Error('A SEFAZ respondeu HTTP ' + code + ' ao consultar a nota.');
  const tipo = String(resp.getHeaders()['Content-Type'] || resp.getHeaders()['content-type'] || '');
  if (/charset=/i.test(tipo)) return resp.getContentText();
  const bruto = resp.getContentText('UTF-8');
  return /charset=["']?iso-8859-1|windows-1252/i.test(bruto) ? resp.getContentText('ISO-8859-1') : bruto;
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
  const vazio = { notas: [], totalMes: 0, totalGeral: 0 };
  if (n < 2) return vazio;
  const vals = sh.getRange(2, 1, n - 1, ABAS.COMPRAS.cab.length).getValues();
  const porChave = {};
  vals.forEach(r => {
    const chave = String(r[0] || r[11] || '');
    if (!chave) return;
    if (!porChave[chave]) {
      porChave[chave] = { chave: chave, data: r[1] instanceof Date ? r[1] : (r[12] || null),
                          estabelecimento: r[2], total: Number(r[10]) || 0, itens: 0 };
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
    .map(r => ({ codigo: String(r[4]), descricao: r[5], quantidade: r[6], unidade: r[7], valorUnitario: r[8], valorTotal: r[9] }));
}
