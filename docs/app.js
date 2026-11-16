'use strict';

/* ============================ Utilidades ============================ */

const $ = s => document.querySelector(s);
const CFG_KEY = 'gastos.cfg';
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBR = iso => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

function el(tag, props = {}, ...filhos) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...filhos.filter(f => f !== null && f !== undefined));
  return e;
}

let cfg = lerCfg();
function lerCfg() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch { return {}; }
}
function salvarCfg(c) {
  cfg = c;
  try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch { /* modo privado */ }
}

let ocupados = 0;
function ocupado(on) {
  ocupados = Math.max(0, ocupados + (on ? 1 : -1));
  document.body.classList.toggle('ocupado', ocupados > 0);
}

let toastTimer;
function toast(msg, erro = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'visivel' + (erro ? ' erro' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), erro ? 6000 : 3000);
}

/* =============================== API ================================ */

// Content-Type text/plain evita o preflight CORS, que o Apps Script não responde.
// `silencioso`: não mostra o indicador de carregamento (usado na atualização automática da lista).
async function api(action, dados = {}, { silencioso = false } = {}) {
  if (!cfg.url || !cfg.token) {
    if (!silencioso) mostrarAba('config');
    throw new Error('Configure a URL do Web App e o token.');
  }
  if (!silencioso) ocupado(true);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, token: cfg.token, ...dados }),
    });
    if (!res.ok) throw new Error('Falha de comunicação (HTTP ' + res.status + ').');
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'Erro desconhecido.');
    return j.data;
  } finally {
    if (!silencioso) ocupado(false);
  }
}

/* =============================== Abas =============================== */

function mostrarAba(nome) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('ativa', b.dataset.aba === nome));
  document.querySelectorAll('.aba').forEach(s => (s.hidden = s.id !== 'aba-' + nome));
  if (nome !== 'escanear') pararCamera();
  if (nome === 'lista' && cfg.url) { carregarLista(); if (!modeloResumo) carregarModelo(); }
  if (nome === 'compras' && cfg.url) carregarCompras();
  if (nome === 'config') { $('#cfg-url').value = cfg.url || ''; $('#cfg-token').value = cfg.token || ''; }
}

/* ========================= Lista de compras ========================= */
/*
 * Uma única lista compartilhada (aba "Lista" da planilha). Vários usuários podem editá-la ao mesmo
 * tempo: cada alteração grava só o campo mudado, identificado pelo ID do item, e a lista é
 * recarregada automaticamente para mostrar o que os outros mudaram.
 */

let itens = [];
let versaoLocal = 0;   // muda a cada edição local; descarta recargas que começaram antes dela
let emAndamento = 0;   // edições ainda não confirmadas pelo servidor
const ATUALIZAR_A_CADA = 15000;

/** Só dois tipos de unidade: KG (quilograma) e UN (unidade, padrão). */
const normUn = u => (/^\s*(k|quil)/i.test(String(u || '')) ? 'KG' : 'UN');
const fmtQtd = q => String(Number(q) || 0).replace('.', ',');

async function carregarLista(silencioso = false) {
  const versao = versaoLocal;
  try {
    const dados = await api('listarItens', {}, { silencioso });
    if (versao !== versaoLocal || emAndamento) return; // uma edição local aconteceu no meio: não sobrescreve
    itens = dados;
    renderLista();
  } catch (e) { if (!silencioso) toast(e.message, true); }
}

/** Executa uma edição otimista: atualiza a tela na hora, grava no servidor e desfaz se falhar. */
async function editar(aplicar, desfazer, chamada) {
  versaoLocal++;
  emAndamento++;
  aplicar();
  renderLista();
  try {
    await chamada();
  } catch (e) {
    desfazer();
    renderLista();
    toast(e.message, true);
    if (/não encontrado/i.test(e.message)) setTimeout(() => carregarLista(), 0); // outro usuário removeu
  } finally {
    emAndamento--;
  }
}

function renderLista() {
  const ul = $('#lista');
  // Não redesenha enquanto o usuário digita uma quantidade (evita perder o foco).
  if (ul.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' &&
      document.activeElement.type === 'number') return;
  ul.replaceChildren();
  const ord = [...itens].sort(porSetorItem);
  const pendentes = itens.filter(i => !i.comprado).length;
  $('#titulo-lista').textContent = `Lista de compras · ${pendentes} pendente(s)`;
  if (!ord.length) {
    ul.append(el('li', { className: 'vazio', textContent: 'Lista vazia — use "Nova lista" ou adicione itens' }));
    return;
  }

  ul.append(el('li', { className: 'cab' },
    el('span', { className: 'setor', textContent: 'Setor' }),
    el('span', { className: 'item-cab', textContent: 'Item' }),
    el('span', { className: 'quant', textContent: 'Quantidade' }),
    el('span', { className: 'del-cab' })));

  for (const it of ord) {
    const cb = el('input', { type: 'checkbox', checked: it.comprado });
    cb.addEventListener('change', () => alternar(it, cb.checked));

    // Coluna Quantidade: tipo de unidade (UN/KG) + quantidade, editáveis.
    const un = el('select', { title: 'Unidade' },
      el('option', { value: 'UN', textContent: 'UN' }), el('option', { value: 'KG', textContent: 'KG' }));
    un.value = normUn(it.unidade);
    const qt = el('input', { type: 'number', min: '0', step: un.value === 'KG' ? '0.001' : '1',
                             value: Number(it.quantidade) || 0, title: 'Quantidade', inputMode: 'decimal' });
    un.addEventListener('change', () => { qt.step = un.value === 'KG' ? '0.001' : '1'; alterarQuantidade(it, qt.value, un.value); });
    qt.addEventListener('change', () => alterarQuantidade(it, qt.value, un.value));

    // Preço de referência (Modelo) ou pago (nota importada) e local.
    const v = Number(it.valorUnitario) || 0;
    const sub = v || it.local
      ? el('span', { className: 'sub', textContent:
          [v ? `${brl.format(v)}/${normUn(it.unidade)}` : '', it.local].filter(Boolean).join(' · ') })
      : null;
    const tag = it.periodicidade ? el('span', { className: 'tag', textContent: it.periodicidade }) : null;

    const del = el('button', { className: 'del', textContent: '✕', title: 'Remover', type: 'button' });
    del.addEventListener('click', () => remover(it));
    ul.append(el('li', { className: it.comprado ? 'feito' : '' },
      el('span', { className: 'setor', textContent: it.setor || '—' }),
      el('label', {}, cb,
        el('span', { className: 'info' }, el('span', { className: 'nome', textContent: it.item }), sub),
        tag),
      el('span', { className: 'quant' }, un, qt),
      del));
  }
}

function alterarQuantidade(it, valor, unidade) {
  const quantidade = Number(String(valor).replace(',', '.'));
  if (!(quantidade >= 0)) { toast('Quantidade inválida.', true); renderLista(); return; }
  const antes = { quantidade: it.quantidade, unidade: it.unidade };
  if (document.activeElement) document.activeElement.blur();
  editar(() => Object.assign(it, { quantidade, unidade }), () => Object.assign(it, antes),
    () => api('atualizarItem', { id: it.id, campos: { quantidade, unidade } }));
}

/** Ordem alfabética por setor e depois item; itens sem setor ficam no fim. */
const cmp = (a, b) => String(a).localeCompare(String(b), 'pt-BR', { sensitivity: 'base' });
function porSetorItem(a, b) {
  if (!a.setor !== !b.setor) return a.setor ? -1 : 1;
  return cmp(a.setor || '', b.setor || '') || cmp(a.item, b.item);
}

/* ---------- Setores conhecidos (sugestões do campo "Setor") ---------- */

let modeloResumo = null;
async function carregarModelo() {
  try {
    modeloResumo = await api('resumoModelo');
    $('#lista-setores').replaceChildren(...modeloResumo.setores.map(s => el('option', { value: s })));
  } catch { /* sugestões são opcionais */ }
  return modeloResumo;
}

/* ---------- Nova lista: itens do Modelo, filtrados por periodicidade, entram na aba Lista ---------- */

const plural = n => `${n} ${n === 1 ? 'item' : 'itens'}`;

async function abrirNovaLista() {
  const f = $('#form-nova');
  if (!f.hidden) { f.hidden = true; return; }
  $('#cont-modelo').textContent = '';
  f.hidden = false;
  const r = await carregarModelo();
  if (!r) return;
  $('#cont-modelo').textContent = ` (${plural(r.total)})`;
  document.querySelectorAll('#form-nova .cont').forEach(s => (s.textContent = `(${plural(r.porFrequencia[s.dataset.freq] || 0)})`));
}

async function criarLista(ev) {
  ev.preventDefault();
  const caixas = [...document.querySelectorAll('#form-nova input[name=freq]')];
  const marcadas = caixas.filter(c => c.checked).map(c => c.value);
  if (!marcadas.length) { toast('Marque ao menos uma periodicidade.', true); return; }
  // Todas marcadas = Modelo inteiro (inclui itens sem periodicidade preenchida).
  const frequencias = marcadas.length === caixas.length ? [] : marcadas;
  try {
    const r = await api('criarLista', { frequencias });
    toast(`${plural(r.adicionados)} incluído(s) na Lista` + (r.reativados ? ` · ${r.reativados} voltaram a ficar pendentes` : '') + '.');
    $('#form-nova').hidden = true;
    carregarLista();
  } catch (e) { toast(e.message, true); }
}

async function adicionar(ev) {
  ev.preventDefault();
  const nome = $('#novo-item').value.trim();
  if (!nome) return;
  const quantidade = Number($('#novo-qtd').value) || 1;
  const setor = $('#novo-setor').value.trim();
  const unidade = $('#novo-un').value;
  $('#novo-item').value = '';
  $('#novo-qtd').value = 1;
  $('#novo-item').focus();
  versaoLocal++;
  try {
    const novo = await api('adicionarItem', { item: { item: nome, quantidade, setor, unidade } });
    itens.push(novo);
    renderLista();
  } catch (e) { toast(e.message, true); $('#novo-item').value = nome; }
}

function alternar(it, marcado) {
  const anterior = it.comprado;
  editar(() => (it.comprado = marcado), () => (it.comprado = anterior),
    () => api('atualizarItem', { id: it.id, campos: { comprado: marcado } }));
}

function remover(it) {
  const copia = itens;
  editar(() => (itens = itens.filter(x => x.id !== it.id)), () => (itens = copia),
    () => api('removerItem', { id: it.id }));
}

async function limparComprados() {
  if (!itens.some(i => i.comprado)) return toast('Nenhum item comprado.');
  if (!confirm('Excluir da aba Lista todos os itens marcados como comprados?')) return;
  versaoLocal++;
  try {
    const r = await api('removerComprados');
    toast(`${r.removidos} item(ns) excluído(s) da Lista.`);
    carregarLista();
  } catch (e) { toast(e.message, true); }
}

/** Atualização automática: traz as mudanças feitas por outros usuários (ou direto na planilha). */
function listaVisivel() { return !$('#aba-lista').hidden && !document.hidden && cfg.url && cfg.token; }
setInterval(() => { if (listaVisivel() && !emAndamento) carregarLista(true); }, ATUALIZAR_A_CADA);
document.addEventListener('visibilitychange', () => { if (listaVisivel()) carregarLista(true); });

/* ============================ NFC-e / QR ============================ */

let leitor = null;
let lendo = false;

async function alternarCamera() {
  if (leitor) return pararCamera();
  if (!window.Html5Qrcode) return toast('O leitor de QR Code não carregou. Verifique a conexão.', true);
  leitor = new Html5Qrcode('leitor');
  lendo = false;
  try {
    await leitor.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: (w, h) => { const l = Math.floor(Math.min(w, h) * 0.75); return { width: l, height: l }; } },
      async texto => {
        if (lendo) return;
        lendo = true;
        await pararCamera();
        importar(texto.trim());
      },
      () => {}
    );
    $('#btn-camera').textContent = 'Fechar câmera';
  } catch (e) {
    leitor = null;
    toast('Não foi possível abrir a câmera: ' + e, true);
  }
}

async function pararCamera() {
  if (!leitor) return;
  const l = leitor;
  leitor = null;
  try { await l.stop(); l.clear(); } catch { /* já parado */ }
  $('#btn-camera').textContent = 'Ler QR Code da nota';
}

/* ---------- Portais que recusam a consulta automática (ex.: SEFAZ-SP) ---------- */

const BLOQ_KEY = 'gastos.portaisBloqueados';
const hostDe = u => { try { return new URL(u).hostname; } catch { return ''; } };
function portaisBloqueados() { try { return JSON.parse(localStorage.getItem(BLOQ_KEY)) || []; } catch { return []; } }
function marcarBloqueado(url) {
  const h = hostDe(url);
  if (!h) return;
  const lista = portaisBloqueados();
  if (!lista.includes(h)) { lista.push(h); try { localStorage.setItem(BLOQ_KEY, JSON.stringify(lista)); } catch { /* ok */ } }
}

/** Quando a SEFAZ não deixa o servidor consultar: o usuário abre a nota e usa o favorito "Enviar para o Gastos". */
function renderAbrirNota(url, motivo) {
  const abrir = el('a', { className: 'botao', href: url, textContent: 'Abrir a nota no site da SEFAZ' });
  const config = el('a', { href: '#', textContent: 'Como instalar o favorito' });
  config.addEventListener('click', ev => { ev.preventDefault(); mostrarAba('config'); $('#favorito').scrollIntoView(); });
  $('#resultado').replaceChildren(el('div', { className: 'aviso' },
    el('p', { textContent: motivo }),
    el('p', { className: 'dica', textContent: 'Toque no botão abaixo. Quando a nota abrir, toque na barra de endereço, ' +
      'digite "Gastos" e escolha o favorito "Enviar para o Gastos". A nota volta para cá e é importada.' }),
    abrir, el('p', { className: 'dica' }, config)));
}

async function importar(url, html) {
  if (!html && !/^https?:\/\//i.test(url)) {
    return toast('Esse QR Code não parece ser de uma NFC-e (esperado um link http).', true);
  }
  // Portal que já recusou antes: nem tenta pelo servidor, vai direto para o plano B.
  if (!html && portaisBloqueados().includes(hostDe(url))) {
    return renderAbrirNota(url, 'Este portal da SEFAZ só pode ser consultado pelo seu navegador.');
  }
  const r = $('#resultado');
  r.replaceChildren(el('p', { className: 'dica', textContent: html ? 'Importando a nota…' : 'Consultando a nota na SEFAZ…' }));
  try {
    const d = await api('importarNfce', { url, html });
    renderResultado(d);
  } catch (e) {
    if (!html && /recusou a conex|Request Rejected|N[ãa]o foi poss[íi]vel acessar o portal/i.test(e.message)) {
      marcarBloqueado(url);
      renderAbrirNota(url, 'A SEFAZ não permite que o app consulte esta nota sozinho.');
      return;
    }
    r.replaceChildren();
    toast(e.message, true);
  }
}

/* ---------- Favorito "Enviar para o Gastos" ---------- */

/**
 * Código do favorito (bookmarklet). Roda na página da nota, no navegador do usuário: remove scripts,
 * estilos e imagens e abre o app levando a página no fragmento do link (#nfce=…), que não vai a servidor algum.
 */
function codigoFavorito() {
  const app = location.origin + location.pathname;
  const js = '(function(){' +
    'if(!/\\.gov\\.br$/i.test(location.hostname)){alert("Abra primeiro a página da nota fiscal no site da SEFAZ.");return}' +
    'var c=document.documentElement.cloneNode(true);' +
    'c.querySelectorAll("script,style,link,img,svg,iframe,noscript,input,meta,button").forEach(function(e){e.remove()});' +
    'var d=JSON.stringify({url:location.href,html:c.outerHTML.replace(/\\s+/g," ")});' +
    'location.href=' + JSON.stringify(app) + '+"#nfce="+encodeURIComponent(d)' +
    '})()';
  return 'javascript:' + encodeURIComponent(js);
}

function prepararFavorito() {
  const codigo = codigoFavorito();
  $('#favorito-codigo').value = codigo;
  $('#favorito-link').href = codigo;
}

async function copiarFavorito() {
  try { await navigator.clipboard.writeText($('#favorito-codigo').value); toast('Código do favorito copiado.'); }
  catch { $('#favorito-codigo').select(); toast('Selecione o texto e copie manualmente.', true); }
}

function renderResultado(d) {
  const n = d.nota;
  const aviso = d.duplicada
    ? el('p', { className: 'aviso', textContent: 'Esta nota já havia sido importada — nada foi gravado de novo.' })
    : el('p', { className: 'aviso ok', textContent:
        `Nota importada: ${n.qtdItens} item(ns) gravado(s) nas abas Compras e ${d.aba}.` +
        (d.marcados.length ? ` Marcados como comprados na Lista: ${d.marcados.join(', ')}.` : '') +
        (d.foraDaLista ? ` ${d.foraDaLista} item(ns) fora da lista.` : '') });

  const tbody = el('tbody');
  for (const it of d.itens) {
    tbody.append(el('tr', {},
      el('td', { textContent: it.descricao }),
      el('td', { className: 'num', textContent: `${String(it.quantidade).replace('.', ',')} ${it.unidade}` }),
      el('td', { className: 'num', textContent: brl.format(it.valorTotal) })));
  }
  const tabela = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', { textContent: 'Produto' }), el('th', { className: 'num', textContent: 'Qtd' }), el('th', { className: 'num', textContent: 'Total' }))),
    tbody);

  $('#resultado').replaceChildren(
    aviso,
    el('div', { className: 'card' },
      el('small', { textContent: `${n.estabelecimento || 'Estabelecimento'} · ${dataBR(n.dataEmissao)}` }),
      el('strong', { textContent: brl.format(n.total) })),
    tabela);
}

/* ============================ Histórico ============================= */

async function carregarCompras() {
  try {
    const d = await api('listarCompras', { limite: 50 });
    $('#resumo').replaceChildren(
      el('div', { className: 'card' }, el('small', { textContent: 'Gasto no mês' }), el('strong', { textContent: brl.format(d.totalMes) })),
      el('div', { className: 'card' }, el('small', { textContent: 'Total registrado' }), el('strong', { textContent: brl.format(d.totalGeral) })));

    const ul = $('#compras');
    ul.replaceChildren();
    if (!d.notas.length) { ul.append(el('li', { className: 'vazio', textContent: 'Nenhuma nota importada ainda' })); return; }
    for (const nt of d.notas) {
      const detalhe = el('div');
      const li = el('li', { className: 'nota' },
        el('div', { className: 'topo' },
          el('span', { className: 'nome', textContent: nt.estabelecimento || 'Sem nome' }),
          el('span', { className: 'valor', textContent: brl.format(nt.total) })),
        el('span', { className: 'meta', textContent: `${dataBR(nt.data)} · ${nt.itens} item(ns)` }),
        detalhe);
      li.addEventListener('click', () => detalhar(nt.chave, detalhe));
      ul.append(li);
    }
  } catch (e) { toast(e.message, true); }
}

async function detalhar(chave, alvo) {
  if (alvo.childElementCount) { alvo.replaceChildren(); return; }
  try {
    const itensNota = await api('detalharCompra', { chave });
    const tbody = el('tbody');
    itensNota.forEach(it => tbody.append(el('tr', {},
      el('td', { textContent: it.descricao }),
      el('td', { className: 'num', textContent: brl.format(Number(it.valorTotal) || 0) }))));
    alvo.replaceChildren(el('table', {}, tbody));
  } catch (e) { toast(e.message, true); }
}

/* =========================== Configuração =========================== */

async function salvarConfig(ev) {
  ev.preventDefault();
  salvarCfg({ url: $('#cfg-url').value.trim(), token: $('#cfg-token').value.trim() });
  try { await api('ping'); toast('Conectado à planilha!'); mostrarAba('lista'); }
  catch (e) { toast('Falhou: ' + e.message, true); }
}

async function copiarLinkConfig() {
  if (!cfg.url || !cfg.token) return toast('Salve a configuração primeiro.', true);
  const link = location.origin + location.pathname + '#cfg=' + encodeURIComponent(btoa(JSON.stringify(cfg)));
  try { await navigator.clipboard.writeText(link); toast('Link copiado. Abra-o no outro aparelho.'); }
  catch { prompt('Copie o link:', link); }
}

/**
 * Aceita #nfce=<json> (página da nota enviada pelo favorito), #cfg=<base64> (configuração)
 * e ?nfce=<link> (importação direta).
 */
function lerParametrosIniciais() {
  const f = location.hash.match(/^#nfce=([\s\S]+)$/);
  if (f) {
    history.replaceState(null, '', location.pathname);
    try {
      const d = JSON.parse(decodeURIComponent(f[1]));
      if (typeof d.html !== 'string' || !/^https:\/\/[^/?#]+\.gov\.br[/?#]/i.test(String(d.url))) throw new Error();
      mostrarAba('escanear');
      $('#link-nfce').value = d.url;
      importar(d.url, d.html);
      return true;
    } catch { toast('Não consegui ler a nota enviada pelo favorito.', true); }
  }
  const m = location.hash.match(/^#cfg=(.+)$/);
  if (m) {
    try {
      const c = JSON.parse(atob(decodeURIComponent(m[1])));
      if (c.url && c.token) { salvarCfg({ url: c.url, token: c.token }); toast('Configuração aplicada.'); }
    } catch { toast('Link de configuração inválido.', true); }
    history.replaceState(null, '', location.pathname + location.search);
  }
  const nfce = new URLSearchParams(location.search).get('nfce');
  if (nfce) {
    history.replaceState(null, '', location.pathname);
    mostrarAba('escanear');
    $('#link-nfce').value = nfce;
    importar(nfce);
    return true;
  }
  return false;
}

/* =============================== Início ============================== */

document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => mostrarAba(b.dataset.aba)));
$('#btn-nova').addEventListener('click', abrirNovaLista);
$('#btn-cancelar-nova').addEventListener('click', () => ($('#form-nova').hidden = true));
$('#form-nova').addEventListener('submit', criarLista);
$('#form-item').addEventListener('submit', adicionar);
$('#btn-limpar').addEventListener('click', limparComprados);
$('#btn-camera').addEventListener('click', alternarCamera);
$('#form-link').addEventListener('submit', ev => { ev.preventDefault(); importar($('#link-nfce').value.trim()); });
$('#btn-html').addEventListener('click', () => {
  const html = $('#html-nfce').value;
  if (!html.trim()) return toast('Cole o HTML da página da nota.', true);
  importar($('#link-nfce').value.trim(), html);
});
$('#form-config').addEventListener('submit', salvarConfig);
$('#btn-link-cfg').addEventListener('click', copiarLinkConfig);
$('#btn-copiar-favorito').addEventListener('click', copiarFavorito);
prepararFavorito();

if (!lerParametrosIniciais()) mostrarAba(cfg.url && cfg.token ? 'lista' : 'config');
