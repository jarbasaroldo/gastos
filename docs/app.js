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
async function api(action, dados = {}) {
  if (!cfg.url || !cfg.token) {
    mostrarAba('config');
    throw new Error('Configure a URL do Web App e o token.');
  }
  ocupado(true);
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
    ocupado(false);
  }
}

/* =============================== Abas =============================== */

function mostrarAba(nome) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('ativa', b.dataset.aba === nome));
  document.querySelectorAll('.aba').forEach(s => (s.hidden = s.id !== 'aba-' + nome));
  if (nome !== 'escanear') pararCamera();
  if (nome === 'lista' && cfg.url) { carregarListas(); if (!modeloResumo) carregarModelo(); }
  if (nome === 'compras' && cfg.url) carregarCompras();
  if (nome === 'config') { $('#cfg-url').value = cfg.url || ''; $('#cfg-token').value = cfg.token || ''; }
}

/* ========================= Lista de compras ========================= */

const LISTA_KEY = 'gastos.lista';
let itens = [];
let listaAtual = (() => { try { return localStorage.getItem(LISTA_KEY) || ''; } catch { return ''; } })();

/** "20261115" -> "15/11/2026" */
const rotuloLista = n => `${n.slice(6, 8)}/${n.slice(4, 6)}/${n.slice(0, 4)}`;

function selecionarLista(nome) {
  listaAtual = nome || '';
  try { localStorage.setItem(LISTA_KEY, listaAtual); } catch { /* modo privado */ }
}

async function carregarListas() {
  try {
    const listas = await api('listarListas');
    if (!listas.includes(listaAtual)) selecionarLista(listas[0] || '');
    const sel = $('#sel-lista');
    sel.replaceChildren(...(listas.length
      ? listas.map(n => el('option', { value: n, textContent: 'Lista de ' + rotuloLista(n), selected: n === listaAtual }))
      : [el('option', { value: '', textContent: 'Nenhuma lista — crie uma' })]));
    await carregarLista();
  } catch (e) { toast(e.message, true); }
}

async function carregarLista() {
  if (!listaAtual) { itens = []; renderLista(); return; }
  try { itens = await api('listarItens', { lista: listaAtual }); renderLista(); } catch (e) { toast(e.message, true); }
}

function renderLista() {
  const ul = $('#lista');
  ul.replaceChildren();
  const comprado = it => it.status === 'Comprado';
  const ord = [...itens].sort(porSetorItem);
  if (!ord.length) {
    ul.append(el('li', { className: 'vazio', textContent: listaAtual ? 'Lista vazia' : 'Crie uma lista em "Nova lista"' }));
    return;
  }

  ul.append(el('li', { className: 'cab' },
    el('span', { className: 'setor', textContent: 'Setor' }), el('span', { textContent: 'Item' })));

  for (const it of ord) {
    const cb = el('input', { type: 'checkbox', checked: comprado(it) });
    cb.addEventListener('change', () => alternar(it, cb.checked));
    const qtd = it.quantidade && Number(it.quantidade) !== 1 ? `${it.quantidade} ${it.unidade || ''}`.trim() : (it.unidade || '');

    // Dados da NFC-e conciliada: "1,235 × 6,49 = R$ 8,02"
    let sub = null;
    if (it.chave && it.valorUnitario !== '') {
      const q = Number(it.qtdComprada) || 0, v = Number(it.valorUnitario) || 0;
      const desc = it.descricaoNfce && it.descricaoNfce !== it.item ? it.descricaoNfce + ' · ' : '';
      sub = el('span', { className: 'sub', textContent: `${desc}${String(q).replace('.', ',')} × ${v.toFixed(2).replace('.', ',')} = ${brl.format(q * v)}` });
    }
    const tag = it.origem === 'NFC-e'
      ? el('span', { className: 'tag nfce', textContent: 'fora da lista' })
      : (it.frequencia ? el('span', { className: 'tag', textContent: it.frequencia }) : null);

    const del = el('button', { className: 'del', textContent: '✕', title: 'Remover', type: 'button' });
    del.addEventListener('click', () => remover(it));
    ul.append(el('li', { className: comprado(it) ? 'feito' : '' },
      el('span', { className: 'setor', textContent: it.setor || '—' }),
      el('label', {}, cb,
        el('span', { className: 'info' }, el('span', { className: 'nome', textContent: it.item }), sub),
        tag,
        el('span', { className: 'qtd', textContent: qtd })),
      del));
  }
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

/* ---------- Nova lista (sempre a partir da aba Modelo) ---------- */

async function abrirNovaLista() {
  const f = $('#form-nova');
  if (!f.hidden) { f.hidden = true; return; }
  $('#nova-data').value = new Date().toLocaleDateString('sv-SE'); // aaaa-mm-dd no fuso local
  $('#cont-modelo').textContent = '';
  f.hidden = false;
  const r = await carregarModelo();
  if (r) $('#cont-modelo').textContent = ` (${r.total} ${r.total === 1 ? 'item' : 'itens'})`;
}

async function criarLista(ev) {
  ev.preventDefault();
  const data = $('#nova-data').value.replace(/-/g, '');
  try {
    const r = await api('criarLista', { data });
    toast((r.criada ? 'Lista criada' : 'A lista já existia') + ` · ${r.adicionados} item(ns) do Modelo incluído(s).`);
    $('#form-nova').hidden = true;
    selecionarLista(r.nome);
    carregarListas();
  } catch (e) { toast(e.message, true); }
}

async function adicionar(ev) {
  ev.preventDefault();
  if (!listaAtual) { toast('Crie ou escolha uma lista primeiro.', true); return; }
  const nome = $('#novo-item').value.trim();
  if (!nome) return;
  const quantidade = Number($('#novo-qtd').value) || 1;
  const setor = $('#novo-setor').value.trim();
  $('#novo-item').value = '';
  $('#novo-qtd').value = 1;
  $('#novo-item').focus();
  try {
    const novo = await api('adicionarItem', { lista: listaAtual, item: { item: nome, quantidade, setor } });
    itens.push(novo);
    renderLista();
  } catch (e) { toast(e.message, true); $('#novo-item').value = nome; }
}

async function alternar(it, marcado) {
  const anterior = it.status;
  it.status = marcado ? 'Comprado' : 'Pendente';
  renderLista();
  try { await api('atualizarItem', { lista: listaAtual, id: it.id, campos: { status: it.status } }); }
  catch (e) { it.status = anterior; renderLista(); toast(e.message, true); }
}

async function remover(it) {
  const copia = itens;
  itens = itens.filter(x => x.id !== it.id);
  renderLista();
  try { await api('removerItem', { lista: listaAtual, id: it.id }); }
  catch (e) { itens = copia; renderLista(); toast(e.message, true); }
}

async function limparComprados() {
  if (!itens.some(i => i.status === 'Comprado')) return toast('Nenhum item comprado.');
  if (!confirm('Remover todos os itens marcados como comprados?')) return;
  try {
    const r = await api('removerComprados', { lista: listaAtual });
    toast(`${r.removidos} item(ns) removido(s).`);
    carregarLista();
  } catch (e) { toast(e.message, true); }
}

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

async function importar(url, html) {
  if (!html && !/^https?:\/\//i.test(url)) {
    return toast('Esse QR Code não parece ser de uma NFC-e (esperado um link http).', true);
  }
  const r = $('#resultado');
  r.replaceChildren(el('p', { className: 'dica', textContent: 'Consultando a nota na SEFAZ…' }));
  try {
    const d = await api('importarNfce', { url, html });
    if (d.lista) selecionarLista(d.lista); // a aba "Lista" passa a mostrar a lista do dia da compra
    renderResultado(d);
  } catch (e) {
    r.replaceChildren();
    toast(e.message, true);
  }
}

function renderResultado(d) {
  const n = d.nota;
  const aviso = d.duplicada
    ? el('p', { className: 'aviso', textContent: 'Esta nota já havia sido importada — nada foi gravado de novo.' })
    : el('p', { className: 'aviso ok', textContent:
        `Nota importada: ${n.qtdItens} item(ns) gravado(s) na aba Compras e copiado(s) para a lista ${rotuloLista(d.lista)}.` +
        (d.marcados.length ? ` Conciliados com a lista: ${d.marcados.join(', ')}.` : '') +
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

/** Aceita #cfg=<base64> (configuração) e ?nfce=<link> (importação direta). */
function lerParametrosIniciais() {
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
$('#sel-lista').addEventListener('change', ev => { selecionarLista(ev.target.value); carregarLista(); });
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

if (!lerParametrosIniciais()) mostrarAba(cfg.url && cfg.token ? 'lista' : 'config');
