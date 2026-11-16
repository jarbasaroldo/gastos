/**
 * Controle de Gastos — Backend (Google Apps Script, gratuito)
 *
 * Expõe uma API JSON (Web App) que:
 *   - mantém UMA lista de compras compartilhada na aba "Lista" (vários usuários ao mesmo tempo);
 *   - inclui na Lista os itens da aba "Modelo" filtrados por periodicidade;
 *   - consulta a NFC-e na SEFAZ a partir do link do QR Code, grava os itens na aba "Compras",
 *     marca os itens comprados na Lista e grava a compra na aba "aaaammdd" (data da compra);
 *   - registra erros de importação na aba "Log".
 *
 * As abas "Lista" e "aaaammdd" têm exatamente as colunas e a formatação da aba "Modelo".
 * A coluna sem título do Modelo (coluna A) guarda o ID do item na Lista e a chave da nota na aba do dia.
 *
 * Instalação: veja README.md (rodar setup() uma vez e implantar como App da Web).
 */

const SPREADSHEET_ID = '1FyjzkPfp0D40FAzETEM7JQ_-I2CSNiSFO-_7gHgxmp4';
const FUSO = 'America/Sao_Paulo';
const NOME = { MODELO: 'Modelo', LISTA: 'Lista', COMPRAS: 'Compras', LOG: 'Log' };

/** Cabeçalho usado se a aba Modelo não existir (é o layout atual do Modelo). */
const CAB_MODELO_PADRAO = ['', 'Item', 'Periodicidade estimada', 'Setor', 'Unidade', 'Quantidade',
  'Valor Unitário (R$)', 'Valor Total (R$)', 'Local', 'Comprado'];

const ABAS = {
  // Mesma ordem de colunas da aba Modelo (a coluna A guarda a chave da nota).
  COMPRAS: {
    nome: NOME.COMPRAS,
    cab: ['ChaveNFCe', 'Item', 'Periodicidade', 'Setor', 'Unidade', 'Quantidade',
          'Valor Unitário', 'Valor Total', 'Local', 'Data Compra'],
  },
  LOG: { nome: NOME.LOG, cab: ['DataHora', 'Acao', 'Chave', 'Erro', 'Detalhe', 'Url'] },
};
const CC = {}; // índice de coluna da aba Compras (1-based)
ABAS.COMPRAS.cab.forEach((h, i) => (CC[h] = i + 1));

/** Layouts antigos da aba Compras, convertidos automaticamente para o atual. */
const CABS_COMPRAS_ANTIGOS = [
  ['ChaveNFCe', 'DataEmissao', 'Estabelecimento', 'CNPJ', 'Codigo', 'Descricao', 'Quantidade', 'Unidade',
   'ValorUnitario', 'ValorTotalItem', 'TotalNota', 'UrlConsulta', 'ImportadoEm'],
  ['ChaveNFCe', 'DataEmissao', 'Estabelecimento', 'Descricao', 'Quantidade', 'Unidade', 'ValorUnitario', 'TotalNota'],
];
/** Layout da primeira versão da aba Lista, convertido automaticamente. */
const CAB_LISTA_V1 = ['ID', 'Item', 'Quantidade', 'Unidade', 'Categoria', 'Status', 'CriadoEm', 'CompradoEm'];

const PALAVRAS_IGNORADAS = { com: 1, sem: 1, para: 1, tipo: 1, und: 1, unidade: 1, pct: 1, pacote: 1 };
const FREQUENCIAS = ['Semanal', 'Quinzenal', 'Mensal', 'Demanda'];
const FORMATO_VALOR = '0.00'; // exibe NN,NN numa planilha com localidade Brasil

/* ============================== Instalação ============================== */

/** Rode UMA vez pelo editor: cria as abas fixas e gera o token de acesso. */
function setup() {
  const ss = ss_();
  if (!acharAba_(ss, NOME.MODELO)) {
    const m = ss.insertSheet(NOME.MODELO);
    m.getRange(1, 1, 1, CAB_MODELO_PADRAO.length).setValues([CAB_MODELO_PADRAO]).setFontWeight('bold');
    m.setFrozenRows(1);
  }
  aba_(ss, ABAS.COMPRAS);
  aba_(ss, ABAS.LOG);
  abaLista_(ss);
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
  ping:             ()  => ({ versao: 3, hora: new Date().toISOString() }),
  resumoModelo:     ()  => resumoModelo_(),
  criarLista:       req => comLock_(() => criarLista_(req.frequencias)),
  listarItens:      ()  => listarItens_(),
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

/** Serializa as gravações: dois usuários editando ao mesmo tempo não se atropelam. */
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

/** Localiza uma aba pelo nome sem diferenciar maiúsculas/espaços ("modelo" == "Modelo "). */
function acharAba_(ss, nome) {
  const alvo = nome.trim().toLowerCase();
  return ss.getSheets().filter(s => s.getName().trim().toLowerCase() === alvo)[0] || null;
}

/** Cabeçalho da aba, sem espaços nas pontas e sem colunas vazias à direita. */
function cabecalho_(sh) {
  const larg = sh.getLastColumn();
  if (!larg) return [];
  const cab = sh.getRange(1, 1, 1, larg).getValues()[0].map(h => String(h).trim());
  while (cab.length && !cab[cab.length - 1]) cab.pop();
  return cab;
}

function dados_(sh, largura) {
  const n = sh.getLastRow();
  return n > 1 ? sh.getRange(2, 1, n - 1, largura).getValues() : [];
}

function colLetra_(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function aba_(ss, def) {
  let sh = acharAba_(ss, def.nome);
  if (!sh) sh = ss.insertSheet(def.nome);
  if (sh.getLastRow() === 0) {
    escreverCab_(sh, def.cab);
    if (def === ABAS.COMPRAS) formatarCompras_(sh, 2, sh.getMaxRows() - 1);
    return sh;
  }
  if (def === ABAS.COMPRAS) migrarCompras_(sh, ss);
  return sh;
}

function iso_(v) { return v instanceof Date ? v.toISOString() : (v || ''); }

function simNao_(v) {
  return v === true || /^(true|verdadeiro|sim|s|x|ok|comprado|1)$/i.test(String(v || '').trim());
}

/* ===================== Layout no formato da aba Modelo =================== */

let LAYOUT_ = null;

/**
 * Colunas da aba Modelo (lidas do cabeçalho real). Lista e abas "aaaammdd" usam exatamente este layout.
 * Cada campo guarda o número da coluna (1-based) ou 0 se o Modelo não tiver aquela coluna.
 */
function layout_(ss) {
  if (LAYOUT_) return LAYOUT_;
  const m = acharAba_(ss, NOME.MODELO);
  let cab = m ? cabecalho_(m) : [];
  if (!cab.length) cab = CAB_MODELO_PADRAO.slice();
  const norm = cab.map(normalizar_);
  const col = nomes => norm.findIndex(h => h && nomes.some(n => h === n || h.indexOf(n) === 0)) + 1;
  let chave = norm.indexOf('') + 1;            // coluna sem título: ID na Lista / chave da nota na aba do dia
  if (!chave) { cab.push('ID'); chave = cab.length; }
  LAYOUT_ = {
    cab: cab, largura: cab.length, chave: chave,
    item: col(['item', 'produto', 'descricao']),
    periodicidade: col(['periodicidade', 'frequencia', 'recorrencia']),
    setor: col(['setor', 'secao', 'departamento', 'categoria']),
    unidade: col(['unidade', 'un']),
    quantidade: col(['quantidade', 'qtd', 'qtde']),
    valorUnitario: col(['valor unitario', 'vl unit', 'preco']),
    valorTotal: col(['valor total', 'total']),
    local: col(['local', 'estabelecimento', 'loja', 'mercado']),
    comprado: col(['comprado', 'status']),
  };
  if (!LAYOUT_.item) throw new Error('A aba Modelo precisa ter uma coluna "Item".');
  return LAYOUT_;
}

/** Aplica cabeçalho, formatação, largura das colunas e congelamento da aba Modelo numa aba nova. */
function formatarComoModelo_(ss, sh) {
  const L = layout_(ss);
  sh.getRange(1, 1, 1, L.largura).setValues([L.cab]);
  const m = acharAba_(ss, NOME.MODELO);
  if (m && m.getLastColumn() > 0) {
    const w = Math.min(L.largura, m.getLastColumn());
    m.getRange(1, 1, 1, w).copyTo(sh.getRange(1, 1), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    if (m.getLastRow() >= 2) m.getRange(2, 1, 1, w).copyFormatToRange(sh, 1, w, 2, sh.getMaxRows());
    for (let c = 1; c <= w; c++) sh.setColumnWidth(c, m.getColumnWidth(c));
  } else {
    sh.getRange(1, 1, 1, L.largura).setFontWeight('bold');
  }
  sh.setFrozenRows(1);
  sh.getRange(2, L.chave, sh.getMaxRows() - 1, 1).setNumberFormat('@'); // ID/chave sempre como texto
}

function caixasDeSelecao_(sh, L, linha, qtd) {
  if (!L.comprado || qtd < 1) return;
  sh.getRange(linha, L.comprado, qtd, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
}

/* ================================= Log ================================== */

/** Grava na aba Log. `info = true` para eventos informativos (não aparecem como erro no console). */
function log_(acao, chave, erro, detalhe, url, info) {
  try {
    const sh = aba_(ss_(), ABAS.LOG);
    sh.appendRow([new Date(), acao, chave ? "'" + chave : '', erro || '', detalhe || '', url || '']);
  } catch (e) {
    console.error('Falha ao gravar log: ' + e);
  }
  const msg = '[' + acao + '] ' + erro + (detalhe ? ' | ' + detalhe : '');
  if (info) console.info(msg); else console.error(msg);
}

/* ======================= Lista de compras (aba Lista) ==================== */

function abaLista_(ss) {
  const L = layout_(ss);
  let sh = acharAba_(ss, NOME.LISTA);
  if (!sh) sh = ss.insertSheet(NOME.LISTA);
  if (sh.getLastRow() === 0) { formatarComoModelo_(ss, sh); return sh; }
  const cab = cabecalho_(sh);
  if (cab.join('|') === L.cab.join('|')) return sh;
  if (cab.join('|') === CAB_LISTA_V1.join('|')) { migrarListaV1_(ss, sh); return sh; }
  throw new Error('A aba Lista tem colunas diferentes da aba Modelo. Esperado: ' +
                  L.cab.map(h => h || '(vazia)').join(' | '));
}

/** Converte a aba Lista da primeira versão para o formato do Modelo, preservando os itens. */
function migrarListaV1_(ss, sh) {
  const antigos = dados_(sh, CAB_LISTA_V1.length).filter(r => String(r[1]).trim()).map(r => ({
    id: r[0], item: r[1], quantidade: r[2], unidade: r[3], setor: r[4], comprado: r[5] === 'Comprado',
  }));
  sh.clear();
  formatarComoModelo_(ss, sh);
  escreverLinhasLista_(ss, sh, antigos);
  log_('migracao (info)', '', 'Aba Lista convertida para o formato do Modelo', antigos.length + ' item(ns)', '', true);
}

/** Monta uma linha da Lista no layout do Modelo. Valor Total vira fórmula Quantidade × Valor Unitário. */
function linhaLista_(L, o, linha) {
  const r = new Array(L.largura).fill('');
  const set = (c, v) => { if (c) r[c - 1] = v; };
  set(L.chave, o.id || Utilities.getUuid());
  set(L.item, String(o.item || '').trim());
  set(L.periodicidade, o.periodicidade || '');
  set(L.setor, o.setor || '');
  set(L.unidade, normUn_(o.unidade));
  set(L.quantidade, Number(o.quantidade) || 1);
  set(L.valorUnitario, o.valorUnitario === undefined ? '' : o.valorUnitario);
  if (L.valorTotal && L.quantidade && L.valorUnitario) {
    set(L.valorTotal, '=' + colLetra_(L.quantidade) + linha + '*' + colLetra_(L.valorUnitario) + linha);
  }
  set(L.local, o.local || '');
  set(L.comprado, !!o.comprado);
  return r;
}

function escreverLinhasLista_(ss, sh, objs) {
  if (!objs.length) return [];
  const L = layout_(ss);
  const inicio = sh.getLastRow() + 1;
  const linhas = objs.map((o, i) => linhaLista_(L, o, inicio + i));
  sh.getRange(inicio, 1, linhas.length, L.largura).setValues(linhas);
  caixasDeSelecao_(sh, L, inicio, linhas.length);
  return linhas;
}

function objLista_(L, r, linha) {
  const get = c => (c ? r[c - 1] : '');
  return {
    id: String(get(L.chave) || ''), linha: linha, item: String(get(L.item) || '').trim(),
    periodicidade: String(get(L.periodicidade) || ''), setor: String(get(L.setor) || '').trim(),
    unidade: normUn_(get(L.unidade)), quantidade: Number(get(L.quantidade)) || 0,
    valorUnitario: Number(get(L.valorUnitario)) || 0, valorTotal: Number(get(L.valorTotal)) || 0,
    local: String(get(L.local) || ''), comprado: simNao_(get(L.comprado)),
  };
}

function lerItens_(ss, sh) {
  const L = layout_(ss);
  return dados_(sh, L.largura).map((r, i) => objLista_(L, r, i + 2)).filter(o => o.item);
}

/** Itens digitados direto na planilha não têm ID: gera um para que o app consiga editá-los. */
function atribuirIds_(ss, sh) {
  const L = layout_(ss);
  dados_(sh, L.largura).forEach((r, i) => {
    if (String(r[L.item - 1] || '').trim() && !r[L.chave - 1]) {
      sh.getRange(i + 2, L.chave).setValue(Utilities.getUuid());
    }
  });
}

function listarItens_() {
  const ss = ss_();
  const sh = abaLista_(ss);
  let itens = lerItens_(ss, sh);
  if (itens.some(i => !i.id)) {
    comLock_(() => atribuirIds_(ss, sh));
    itens = lerItens_(ss, sh);
  }
  return itens;
}

function linhaPorId_(ss, sh, id) {
  const L = layout_(ss);
  const n = sh.getLastRow();
  if (n < 2 || !id) return -1;
  const ids = sh.getRange(2, L.chave, n - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return -1;
}

/**
 * Inclui na Lista os itens do Modelo das periodicidades informadas (vazio = Modelo inteiro).
 * Não apaga nada: itens já pendentes ficam como estão e itens já comprados voltam a ficar pendentes.
 */
function criarLista_(frequencias) {
  const ss = ss_();
  const sh = abaLista_(ss);
  const L = layout_(ss);
  atribuirIds_(ss, sh);
  const freqs = (frequencias || []).map(normFreq_).filter(Boolean);
  const porNome = {};
  lerItens_(ss, sh).forEach(i => (porNome[normalizar_(i.item)] = i));

  const novos = [];
  let reativados = 0;
  lerModelo_(ss)
    .filter(m => !freqs.length || freqs.indexOf(m.frequencia) >= 0)
    .sort(porSetorItem_)
    .forEach(m => {
      const k = normalizar_(m.item);
      const atual = porNome[k];
      if (atual) {
        if (atual.comprado && L.comprado) { sh.getRange(atual.linha, L.comprado).setValue(false); reativados++; }
        atual.comprado = false;
        return;
      }
      porNome[k] = { comprado: false };
      novos.push({ item: m.item, periodicidade: m.periodicidade, setor: m.setor, unidade: m.unidade,
                   quantidade: m.quantidade, valorUnitario: m.valorUnitario, local: m.local });
    });
  escreverLinhasLista_(ss, sh, novos);
  return { adicionados: novos.length, reativados: reativados };
}

/** Ordena por setor e depois item (alfabética, sem diferenciar acentos); sem setor vai para o fim. */
function porSetorItem_(a, b) {
  const sa = normalizar_(a.setor), sb = normalizar_(b.setor);
  if (sa !== sb) return !sa ? 1 : !sb ? -1 : (sa < sb ? -1 : 1);
  const ia = normalizar_(a.item), ib = normalizar_(b.item);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

function adicionarItem_(item) {
  const nome = String(item.item || '').trim();
  if (!nome) throw new Error('Informe o nome do item.');
  const ss = ss_();
  const sh = abaLista_(ss);
  const L = layout_(ss);
  const linha = escreverLinhasLista_(ss, sh, [{
    item: nome, quantidade: item.quantidade, unidade: item.unidade, setor: String(item.setor || '').trim(),
  }])[0];
  return objLista_(L, sh.getRange(sh.getLastRow(), 1, 1, L.largura).getValues()[0] || linha, sh.getLastRow());
}

function atualizarItem_(id, campos) {
  const ss = ss_();
  const sh = abaLista_(ss);
  const L = layout_(ss);
  const linha = linhaPorId_(ss, sh, id);
  if (linha < 0) throw new Error('Item não encontrado (pode ter sido removido por outra pessoa).');
  const set = (c, v) => { if (c) sh.getRange(linha, c).setValue(v); };
  if (campos.quantidade !== undefined) {
    const q = Number(String(campos.quantidade).replace(',', '.'));
    if (isNaN(q) || q < 0) throw new Error('Quantidade inválida.');
    set(L.quantidade, q);
  }
  if (campos.unidade !== undefined) set(L.unidade, normUn_(campos.unidade));
  if (campos.comprado !== undefined) set(L.comprado, !!campos.comprado);
  if (campos.item !== undefined && String(campos.item).trim()) set(L.item, String(campos.item).trim());
  if (campos.setor !== undefined) set(L.setor, String(campos.setor).trim());
  return { id: id };
}

function removerItem_(id) {
  const ss = ss_();
  const sh = abaLista_(ss);
  const linha = linhaPorId_(ss, sh, id);
  if (linha > 0) sh.deleteRow(linha);
  return { id: id };
}

/** Exclui da aba Lista todas as linhas marcadas como compradas. */
function removerComprados_() {
  const ss = ss_();
  const sh = abaLista_(ss);
  const L = layout_(ss);
  const n = sh.getLastRow();
  if (n < 2 || !L.comprado) return { removidos: 0 };
  const st = sh.getRange(2, L.comprado, n - 1, 1).getValues();
  let removidos = 0;
  for (let i = st.length - 1; i >= 0; i--) {
    if (simNao_(st[i][0])) { sh.deleteRow(i + 2); removidos++; }
  }
  return { removidos: removidos };
}

/* ================================ Modelo ================================ */

/** Só dois tipos de unidade na lista: KG (quilograma) e UN (unidade, padrão para todo o resto). */
function normUn_(s) {
  return /^(k|quil)/.test(normalizar_(s)) ? 'KG' : 'UN';
}

function normFreq_(s) {
  const n = normalizar_(s);
  if (n.indexOf('sem') === 0) return 'Semanal';
  if (n.indexOf('quin') === 0) return 'Quinzenal';
  if (n.indexOf('men') === 0) return 'Mensal';
  if (n.indexOf('dem') === 0 || n.indexOf('sob') === 0) return 'Demanda';
  return '';
}

/** Lê a aba Modelo usando o layout detectado pelo cabeçalho. */
function lerModelo_(ss) {
  const sh = acharAba_(ss, NOME.MODELO);
  if (!sh || sh.getLastRow() < 2) return [];
  const L = layout_(ss);
  const get = (r, c) => (c ? r[c - 1] : '');
  return dados_(sh, L.largura)
    .filter(r => String(get(r, L.item) || '').trim())
    .map(r => ({
      item: String(get(r, L.item)).trim(),
      periodicidade: String(get(r, L.periodicidade) || '').trim(),
      frequencia: normFreq_(get(r, L.periodicidade)),
      setor: String(get(r, L.setor) || '').trim(),
      unidade: String(get(r, L.unidade) || '').trim(),
      quantidade: Number(get(r, L.quantidade)) || 1,
      valorUnitario: get(r, L.valorUnitario) === '' ? '' : Number(get(r, L.valorUnitario)) || 0,
      local: String(get(r, L.local) || '').trim(),
    }));
}

function resumoModelo_() {
  const itens = lerModelo_(ss_());
  const cont = {};
  const setores = {};
  FREQUENCIAS.forEach(f => (cont[f] = 0));
  itens.forEach(i => {
    if (cont[i.frequencia] !== undefined) cont[i.frequencia]++;
    if (i.setor) setores[i.setor] = true;
  });
  return { total: itens.length, porFrequencia: cont,
           setores: Object.keys(setores).sort((a, b) => a.localeCompare(b, 'pt-BR')) };
}

/* ===================== Casamento produto da nota ↔ item ================= */

function palavras_(s) {
  return normalizar_(s).split(' ').filter(p => p.length >= 3 && !PALAVRAS_IGNORADAS[p] && !/^\d/.test(p));
}

/**
 * Quão bem o nome de um item ("Carne (patinho/alcatra)") casa com a descrição de um produto da nota
 * ("CARNE PATINHO KG"): 2 = todas as palavras aparecem; 1 = só a primeira palavra; 0 = não casa.
 */
function grau_(nomeItem, descNorm) {
  const ps = palavras_(nomeItem);
  if (!ps.length) return 0;
  const tem = p => descNorm.indexOf(' ' + p) >= 0;
  if (ps.every(tem)) return 2;
  return tem(ps[0]) ? 1 : 0;
}

function refsModelo_(modelo) {
  return modelo.map(m => ({ item: m.item, setor: m.setor, periodicidade: m.periodicidade }));
}

/** Setor e periodicidade de um produto da nota, pelo item do Modelo que melhor casa com ele. */
function classificar_(descricao, refs) {
  const d = ' ' + normalizar_(descricao) + ' ';
  let melhor = null, nota = 0;
  refs.forEach(r => {
    const g = grau_(r.item, d);
    if (g > nota) { nota = g; melhor = r; }
  });
  return melhor ? { setor: melhor.setor, periodicidade: melhor.periodicidade } : { setor: '', periodicidade: '' };
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
    return { duplicada: true, nota: resumoNota_(nota), itens: nota.itens, marcados: [], foraDaLista: 0, aba: null };
  }

  const conc = conciliarLista_(ss, nota, refsModelo_(lerModelo_(ss)));

  // Aba Compras: mesma ordem de colunas da aba Modelo (ver ABAS.COMPRAS.cab).
  const linhas = nota.itens.map((it, k) => [
    nota.chave, it.descricao, conc.classes[k].periodicidade, conc.classes[k].setor, it.unidade,
    it.quantidade, it.valorUnitario, it.valorTotal, nota.estabelecimento, nota.dataEmissao || '',
  ]);
  const inicio = sh.getLastRow() + 1;
  formatarCompras_(sh, inicio, linhas.length);
  sh.getRange(inicio, 1, linhas.length, linhas[0].length).setValues(linhas);

  const aba = gravarAbaDoDia_(ss, nota, conc.classes);
  return { duplicada: false, nota: resumoNota_(nota), itens: nota.itens,
           marcados: conc.marcados, foraDaLista: conc.foraDaLista, aba: aba };
}

/**
 * Marca na aba Lista os itens pendentes que aparecem na nota (Comprado, quantidade, unidade,
 * valor unitário pago e local) e devolve setor/periodicidade de cada produto da nota.
 */
function conciliarLista_(ss, nota, refs) {
  const sh = abaLista_(ss);
  const L = layout_(ss);
  atribuirIds_(ss, sh);
  const descs = nota.itens.map(it => ' ' + normalizar_(it.descricao) + ' ');
  const usados = nota.itens.map(() => false);
  const classes = nota.itens.map(() => null);
  const marcados = [];
  const pendentes = lerItens_(ss, sh).filter(i => !i.comprado);
  const feitos = {};

  // 1ª passada: todas as palavras do item aparecem no produto; 2ª: só a primeira palavra.
  [2, 1].forEach(nivel => pendentes.forEach(item => {
    if (feitos[item.id]) return;
    const j = descs.findIndex((d, k) => !usados[k] && grau_(item.item, d) >= nivel);
    if (j < 0) return;
    usados[j] = true;
    feitos[item.id] = true;
    const it = nota.itens[j];
    classes[j] = { setor: item.setor, periodicidade: item.periodicidade };
    const set = (c, v) => { if (c) sh.getRange(item.linha, c).setValue(v); };
    set(L.comprado, true);
    set(L.quantidade, it.quantidade);
    set(L.unidade, normUn_(it.unidade));
    set(L.valorUnitario, it.valorUnitario);
    set(L.local, nota.estabelecimento);
    marcados.push(item.item);
  }));

  nota.itens.forEach((it, k) => {
    if (classes[k] && classes[k].setor) return;
    const c = classificar_(it.descricao, refs);
    classes[k] = { setor: (classes[k] && classes[k].setor) || c.setor,
                   periodicidade: (classes[k] && classes[k].periodicidade) || c.periodicidade };
  });
  return { marcados: marcados, foraDaLista: usados.filter(u => !u).length, classes: classes };
}

/** Grava a compra na aba "aaaammdd" da data da compra (criada no formato do Modelo, se não existir). */
function gravarAbaDoDia_(ss, nota, classes) {
  const L = layout_(ss);
  const nome = Utilities.formatDate(nota.dataEmissao || new Date(), FUSO, 'yyyyMMdd');
  let sh = ss.getSheetByName(nome);
  if (sh && sh.getLastRow() > 0 && cabecalho_(sh).join('|') !== L.cab.join('|')) {
    // Aba com o mesmo nome em outro formato (lista da versão anterior): preserva com outro nome.
    let novoNome = nome + '_antiga';
    if (ss.getSheetByName(novoNome)) novoNome += '_' + new Date().getTime();
    sh.setName(novoNome);
    log_('aba do dia (info)', nota.chave, 'Aba ' + nome + ' em formato antigo renomeada para ' + novoNome, '', '', true);
    sh = null;
  }
  if (!sh) sh = ss.insertSheet(nome);
  if (sh.getLastRow() === 0) formatarComoModelo_(ss, sh);

  const linhas = nota.itens.map((it, k) => {
    const r = new Array(L.largura).fill('');
    const set = (c, v) => { if (c) r[c - 1] = v; };
    set(L.chave, nota.chave);
    set(L.item, it.descricao);
    set(L.periodicidade, classes[k].periodicidade);
    set(L.setor, classes[k].setor);
    set(L.unidade, it.unidade);
    set(L.quantidade, it.quantidade);
    set(L.valorUnitario, it.valorUnitario);
    set(L.valorTotal, it.valorTotal);
    set(L.local, nota.estabelecimento);
    set(L.comprado, true);
    return r;
  });
  const inicio = sh.getLastRow() + 1;
  sh.getRange(inicio, L.chave, linhas.length, 1).setNumberFormat('@');
  sh.getRange(inicio, 1, linhas.length, L.largura).setValues(linhas);
  caixasDeSelecao_(sh, L, inicio, linhas.length);
  return nome;
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

const MARCAS_ = { acute: '\u0301', grave: '\u0300', circ: '\u0302', tilde: '\u0303', uml: '\u0308', cedil: '\u0327' };
const ENTIDADES_ = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ordm: 'º', ordf: 'ª', deg: '°' };

function decodificar_(s) {
  return s
    .replace(/&([A-Za-z])(acute|grave|circ|tilde|uml|cedil);/g, (_, l, m) => (l + MARCAS_[m]).normalize('NFC'))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&([a-z]+);/gi, (t, n) => (ENTIDADES_[n.toLowerCase()] !== undefined ? ENTIDADES_[n.toLowerCase()] : t));
}

function normalizar_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
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

/* ================================ Compras ================================ */

function formatarCompras_(sh, linha, qtd) {
  if (qtd < 1) return;
  sh.getRange(linha, CC.ChaveNFCe, qtd, 1).setNumberFormat('@');                   // chave de 44 dígitos como texto
  sh.getRange(linha, CC['Valor Unitário'], qtd, 2).setNumberFormat(FORMATO_VALOR); // Valor Unitário e Valor Total
  sh.getRange(linha, CC['Data Compra'], qtd, 1).setNumberFormat('dd/MM/yyyy HH:mm');
}

/** Converte a aba Compras de um layout antigo para o atual, preservando os dados. */
function migrarCompras_(sh, ss) {
  const cab = cabecalho_(sh);
  if (cab.join('|') === ABAS.COMPRAS.cab.join('|')) return;
  if (!CABS_COMPRAS_ANTIGOS.some(a => a.join('|') === cab.join('|'))) {
    throw new Error('A aba Compras tem colunas inesperadas. Esperado: ' + ABAS.COMPRAS.cab.join(', '));
  }
  const dados = dados_(sh, cab.length);
  const refs = refsModelo_(lerModelo_(ss));
  const novos = dados.filter(r => r.some(v => v !== '')).map(r => {
    const o = {};
    cab.forEach((h, i) => (o[h] = r[i]));
    const q = Number(o.Quantidade) || 0, vu = Number(o.ValorUnitario) || 0;
    const cls = classificar_(o.Descricao, refs);
    return [o.ChaveNFCe, o.Descricao, cls.periodicidade, cls.setor, o.Unidade, o.Quantidade, o.ValorUnitario,
            o.ValorTotalItem !== undefined && o.ValorTotalItem !== '' ? o.ValorTotalItem : round2_(q * vu),
            o.Estabelecimento, o.DataEmissao];
  });
  sh.clear();
  escreverCab_(sh, ABAS.COMPRAS.cab);
  formatarCompras_(sh, 2, sh.getMaxRows() - 1);
  if (novos.length) sh.getRange(2, 1, novos.length, novos[0].length).setValues(novos);
  log_('migracao (info)', '', 'Aba Compras convertida para o novo layout', novos.length + ' linha(s)', '', true);
}

function listarCompras_(limite) {
  const sh = aba_(ss_(), ABAS.COMPRAS);
  const n = sh.getLastRow();
  if (n < 2) return { notas: [], totalMes: 0, totalGeral: 0 };
  const vals = sh.getRange(2, 1, n - 1, ABAS.COMPRAS.cab.length).getValues();
  const porChave = {};
  vals.forEach(r => {
    const data = r[CC['Data Compra'] - 1], local = r[CC.Local - 1];
    const chave = String(r[CC.ChaveNFCe - 1] || '') || (local + '|' + iso_(data));
    if (chave === '|') return;
    if (!porChave[chave]) {
      porChave[chave] = { chave: chave, data: data instanceof Date ? data : null,
                          estabelecimento: local, total: 0, itens: 0 };
    }
    porChave[chave].total += Number(r[CC['Valor Total'] - 1]) || 0; // total da nota = soma dos itens
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
    notas: notas.slice(0, limite).map(nt => ({ chave: nt.chave, data: iso_(nt.data), estabelecimento: nt.estabelecimento, total: round2_(nt.total), itens: nt.itens })),
    totalMes: round2_(totalMes),
    totalGeral: round2_(totalGeral),
  };
}

function detalharCompra_(chave) {
  const sh = aba_(ss_(), ABAS.COMPRAS);
  const n = sh.getLastRow();
  if (n < 2 || !chave) return [];
  return sh.getRange(2, 1, n - 1, ABAS.COMPRAS.cab.length).getValues()
    .filter(r => String(r[CC.ChaveNFCe - 1]) === chave)
    .map(r => ({ descricao: r[CC.Item - 1], setor: r[CC.Setor - 1], quantidade: r[CC.Quantidade - 1],
                 unidade: r[CC.Unidade - 1], valorUnitario: r[CC['Valor Unitário'] - 1],
                 valorTotal: r[CC['Valor Total'] - 1] }));
}
