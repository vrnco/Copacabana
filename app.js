import { createClient } from './supabase-client.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { sortearDuplas, buildHistoryMap, pairKey, shuffle } from './matching.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const WEEKDAY_NAMES = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado',
];

// ============================================================
// Estado global simples
// ============================================================
const state = {
  session: null,
  profile: null, // { id, name }
  currentRound: null, // { round, category, circuit, players, draft }
  historyPreselectCircuitId: null, // usado pelo botão "Ver histórico" em Administração → Circuitos
};

// ============================================================
// Helpers gerais
// ============================================================
function $(sel, root = document) {
  return root.querySelector(sel);
}
function $all(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayWeekday() {
  return new Date().getDay();
}

function formatDateBR(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// ------------------------------------------------------------
// Numeração automática das rodadas (Rodada 1, Rodada 2, ...)
// Sempre calculada na hora, por categoria + circuito, pela ORDEM
// CRONOLÓGICA das datas das rodadas aprovadas - nunca é salva no
// banco, então se um dia cadastrarem uma rodada "atrasada" (de uma
// data anterior), a numeração se ajusta sozinha automaticamente.
// ------------------------------------------------------------

// Recebe uma lista de datas (round_date, pode ter repetidas) e devolve
// um Map data -> número da rodada (1, 2, 3...) dentro daquele grupo.
function buildRoundNumberIndex(dates) {
  const distinct = [...new Set(dates)].sort();
  const map = new Map();
  distinct.forEach((d, i) => map.set(d, i + 1));
  return map;
}

// Número da rodada de UMA data específica, dado o histórico de datas já
// aprovadas daquela categoria+circuito. Funciona tanto para uma rodada já
// aprovada (retorna a posição dela) quanto para uma ainda não aprovada /
// futura (calcula qual número ela vai ocupar quando for aprovada).
function roundNumberForDate(dateISO, approvedDates) {
  const map = buildRoundNumberIndex(approvedDates);
  if (map.has(dateISO)) return map.get(dateISO);
  const distinctBefore = [...map.keys()].filter((d) => d < dateISO).length;
  return distinctBefore + 1;
}

function genderLabel(g) {
  return g === 'masculino' ? 'Masculino' : 'Feminino';
}

function alertBox(kind, message) {
  return el('div', { class: `alert alert-${kind}` }, message);
}

// Pede confirmação DUAS vezes antes de qualquer exclusão definitiva
// (proteção extra contra clique sem querer em ações irreversíveis).
function confirmDelete(label, detail = '') {
  const detailSuffix = detail ? `\n\n${detail}` : '';
  if (!confirm(`Tem certeza que quer excluir ${label}?${detailSuffix}`)) return false;
  if (!confirm(`Confirmando de novo: excluir ${label} definitivamente? Essa ação não pode ser desfeita.`)) return false;
  return true;
}

function sortIdsPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

// ============================================================
// Navegação entre telas
// ============================================================
const VIEWS = ['home', 'round', 'history', 'admin'];

function showView(name) {
  for (const v of VIEWS) {
    $(`#view-${v}`).classList.toggle('hidden', v !== name);
  }
  $all('#main-nav button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });
  if (name === 'home') renderHome();
  if (name === 'history') renderHistory();
  if (name === 'admin') {
    $all('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.adminTab === 'circuitos'));
    renderAdmin('circuitos');
  }
}

$('#main-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  showView(btn.dataset.view);
});

$('#round-back-btn').addEventListener('click', () => showView('home'));

// ============================================================
// Autenticação
// ============================================================
async function ensureProfile(userId, fallbackEmail) {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;
  if (data) return data;
  // Perfil ainda não existe (esqueceram de criar via SQL) - cria com base no e-mail
  const name = fallbackEmail ? fallbackEmail.split('@')[0] : 'Administrador';
  const { data: created, error: insErr } = await supabase
    .from('profiles')
    .insert({ id: userId, name })
    .select()
    .single();
  if (insErr) throw insErr;
  return created;
}

async function handleLoginSuccess(session) {
  state.session = session;
  try {
    state.profile = await ensureProfile(session.user.id, session.user.email);
  } catch (err) {
    console.error(err);
    state.profile = { id: session.user.id, name: session.user.email || 'Admin' };
  }
  $('#view-login').classList.add('hidden');
  $('#app-root').classList.remove('hidden');
  $('#user-chip').textContent = state.profile.name;
  showView('home');
}

function handleLogout() {
  state.session = null;
  state.profile = null;
  $('#app-root').classList.add('hidden');
  $('#view-login').classList.remove('hidden');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;
  const alertHost = $('#login-alert');
  alertHost.innerHTML = '';
  $('#login-submit').disabled = true;
  $('#login-submit').textContent = 'Entrando...';
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  $('#login-submit').disabled = false;
  $('#login-submit').textContent = 'Entrar';
  if (error) {
    alertHost.append(alertBox('error', 'Não foi possível entrar: ' + error.message));
    return;
  }
  await handleLoginSuccess(data.session);
});

$('#logout-btn').addEventListener('click', async () => {
  await supabase.auth.signOut();
  handleLogout();
});

async function bootstrapAuth() {
  const { data } = await supabase.auth.getSession();
  if (data.session) {
    await handleLoginSuccess(data.session);
  } else {
    $('#view-login').classList.remove('hidden');
  }
}

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') handleLogout();
});

// ============================================================
// Acesso a dados - helpers
// ============================================================
async function getCircuits({ onlyActive = false } = {}) {
  let q = supabase.from('circuits').select('*').order('start_date', { ascending: false });
  if (onlyActive) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function getCategories({ onlyActive = true, circuitId } = {}) {
  let q = supabase.from('categories').select('*, circuit:circuits(id,name,is_active)').order('weekday').order('name');
  if (onlyActive) q = q.eq('is_active', true);
  if (circuitId) q = q.eq('circuit_id', circuitId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function getPlayers(categoryId, { onlyActive = true } = {}) {
  let q = supabase.from('players').select('*').eq('category_id', categoryId).order('name');
  if (onlyActive) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function findOrCreateRound(categoryId, circuitId, dateISO) {
  const { data: existing, error } = await supabase
    .from('rounds')
    .select('*')
    .eq('category_id', categoryId)
    .eq('circuit_id', circuitId)
    .eq('round_date', dateISO)
    .maybeSingle();
  if (error) throw error;
  if (existing) return existing;

  const { data: created, error: insErr } = await supabase
    .from('rounds')
    .insert({
      category_id: categoryId,
      circuit_id: circuitId,
      round_date: dateISO,
      status: 'rascunho',
      created_by: state.profile.id,
    })
    .select()
    .single();
  if (insErr) {
    // 23505 = violação de índice único: outro admin já criou essa rodada
    // no mesmo instante. Em vez de mostrar erro, simplesmente reaproveita.
    if (insErr.code === '23505') {
      const { data: raceWinner, error: refetchErr } = await supabase
        .from('rounds')
        .select('*')
        .eq('category_id', categoryId)
        .eq('circuit_id', circuitId)
        .eq('round_date', dateISO)
        .single();
      if (refetchErr) throw refetchErr;
      return raceWinner;
    }
    throw insErr;
  }
  return created;
}

async function getRoundParticipants(roundId) {
  const { data, error } = await supabase
    .from('round_participants')
    .select('player_id, players(id, name, is_active)')
    .eq('round_id', roundId);
  if (error) throw error;
  return (data || []).map((r) => r.players).filter(Boolean);
}

async function saveRoundParticipants(roundId, playerIds) {
  const { error: delErr } = await supabase.from('round_participants').delete().eq('round_id', roundId);
  if (delErr) throw delErr;
  if (playerIds.length > 0) {
    const rows = playerIds.map((pid) => ({ round_id: roundId, player_id: pid }));
    const { error: insErr } = await supabase.from('round_participants').insert(rows);
    if (insErr) throw insErr;
  }
}

async function updateRound(roundId, patch) {
  const { data, error } = await supabase.from('rounds').update(patch).eq('id', roundId).select().single();
  if (error) throw error;
  return data;
}

async function deleteRound(roundId) {
  const { error } = await supabase.from('rounds').delete().eq('id', roundId);
  if (error) throw error;
}

// Histórico de duplas aprovadas dentro de uma categoria + circuito
async function getApprovedPairsHistory(categoryId, circuitId) {
  const { data, error } = await supabase
    .from('pairs')
    .select('id, player1_id, player2_id, round:rounds!inner(round_date, status, category_id, circuit_id)')
    .eq('round.status', 'aprovado')
    .eq('round.category_id', categoryId)
    .eq('round.circuit_id', circuitId);
  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id,
    player1_id: row.player1_id,
    player2_id: row.player2_id,
    round_date: row.round.round_date,
  }));
}

async function getPairsForRound(roundId) {
  const { data, error } = await supabase
    .from('pairs')
    .select(
      `id, is_repeat,
       player1:players!pairs_player1_id_fkey(id,name),
       player2:players!pairs_player2_id_fkey(id,name),
       repeat_of:pairs!pairs_repeat_of_pair_id_fkey(round:rounds(round_date))`
    )
    .eq('round_id', roundId);
  if (error) throw error;
  return data || [];
}

// ============================================================
// HOME
// ============================================================
async function renderHome() {
  const host = $('#home-content');
  host.innerHTML = '';
  host.append(el('p', { class: 'muted' }, 'Carregando...'));

  try {
    const [activeCircuits, categories] = await Promise.all([getCircuits({ onlyActive: true }), getCategories()]);

    host.innerHTML = '';

    const activeCircuitIds = new Set(activeCircuits.map((c) => c.id));
    // só considera categorias cujo circuito ainda está ativo (uma categoria
    // pode continuar "ativa" mas pertencer a um circuito já encerrado)
    const activeCategories = categories.filter((c) => activeCircuitIds.has(c.circuit_id));
    const multiploCircuitos = activeCircuits.length > 1;

    if (activeCircuits.length === 0) {
      host.append(
        alertBox(
          'warn',
          'Nenhum circuito está ativo no momento. Crie um circuito em Administração → Circuitos antes de sortear.'
        )
      );
    } else if (activeCategories.length === 0) {
      host.append(alertBox('warn', 'Nenhuma categoria cadastrada ainda nos circuitos ativos. Cadastre em Administração → Categorias.'));
    }

    const wd = todayWeekday();
    const todaysCategories = activeCategories.filter((c) => c.weekday === wd);
    const dateNow = todayISO();

    if (todaysCategories.length > 0) {
      todaysCategories.forEach((cat) => {
        const circuit = activeCircuits.find((ci) => ci.id === cat.circuit_id);
        const box = el('div', { class: 'suggestion' }, [
          el('div', { class: 'muted' }, `Hoje é ${WEEKDAY_NAMES[wd]} · ${formatDateBR(dateNow)}`),
          el('h2', {}, `Categoria do dia: ${cat.name}`),
          el('div', { class: 'muted' }, `${genderLabel(cat.gender)}${multiploCircuitos ? ' · ' + circuit.name : ''}`),
          el(
            'button',
            {
              class: 'btn btn-primary',
              style: 'margin-top:0.8rem;',
              onclick: () => goToRound(cat, circuit, dateNow),
            },
            'Abrir rodada de hoje'
          ),
        ]);
        host.append(box);
      });
    } else if (activeCircuits.length > 0) {
      host.append(
        el('div', { class: 'card' }, [
          el('h3', {}, 'Hoje'),
          el('p', { class: 'muted' }, `Nenhuma categoria configurada para ${WEEKDAY_NAMES[wd]}.`),
        ])
      );
    }

    // Abrir outra categoria manualmente
    if (activeCategories.length > 0) {
      const catSelect = el(
        'select',
        { id: 'manual-cat-select' },
        activeCategories.map((c) => {
          const circuit = activeCircuits.find((ci) => ci.id === c.circuit_id);
          const label = `${c.name} (${genderLabel(c.gender)}) · ${WEEKDAY_NAMES[c.weekday]}${multiploCircuitos ? ' · ' + circuit.name : ''}`;
          return el('option', { value: c.id }, label);
        })
      );
      const dateInput = el('input', { type: 'date', id: 'manual-date-input', value: dateNow });

      host.append(
        el('div', { class: 'card' }, [
          el('h3', {}, 'Abrir outra categoria / outra data'),
          el('div', { class: 'field' }, [el('label', {}, 'Categoria'), catSelect]),
          el('div', { class: 'field' }, [el('label', {}, 'Data da rodada'), dateInput]),
          el(
            'button',
            {
              class: 'btn btn-block',
              onclick: () => {
                const cat = activeCategories.find((c) => c.id === catSelect.value);
                const circuit = activeCircuits.find((ci) => ci.id === cat.circuit_id);
                goToRound(cat, circuit, dateInput.value);
              },
            },
            'Abrir'
          ),
        ])
      );
    }
  } catch (err) {
    console.error(err);
    host.innerHTML = '';
    host.append(alertBox('error', 'Erro ao carregar: ' + err.message));
  }
}

function goToRound(category, circuit, dateISO) {
  state.currentRound = { category, circuit, dateISO };
  showView('round');
  renderRound();
}

// ============================================================
// RODADA / SORTEIO
// ============================================================
async function renderRound() {
  const host = $('#round-content');
  host.innerHTML = '';
  host.append(el('p', { class: 'muted' }, 'Carregando...'));

  const { category, circuit, dateISO } = state.currentRound;

  try {
    const round = await findOrCreateRound(category.id, circuit.id, dateISO);
    state.currentRound.round = round;

    const historyRows = await getApprovedPairsHistory(category.id, circuit.id);
    const roundNumber = roundNumberForDate(dateISO, historyRows.map((h) => h.round_date));

    host.innerHTML = '';
    host.append(
      el('div', { class: 'round-number-chip' }, `🎾 Rodada ${roundNumber}`),
      el('h1', {}, category.name),
      el('p', { class: 'muted' }, `${genderLabel(category.gender)} · ${formatDateBR(dateISO)} · Circuito: ${circuit.name}`)
    );

    if (round.status === 'aprovado') {
      await renderApprovedRound(host, round, category, circuit);
      return;
    }

    await renderDraftRound(host, round, category, circuit);
  } catch (err) {
    console.error(err);
    host.innerHTML = '';
    host.append(alertBox('error', 'Erro: ' + err.message));
  }
}

async function renderApprovedRound(host, round, category, circuit) {
  const [pairs, historyRows] = await Promise.all([
    getPairsForRound(round.id),
    getApprovedPairsHistory(category.id, circuit.id),
  ]);
  const roundNumberIndex = buildRoundNumberIndex(historyRows.map((h) => h.round_date));

  host.append(alertBox('success', 'Esta rodada já foi sorteada e aprovada. Resultado final abaixo (somente leitura).'));
  const list = el('div', { class: 'list' });
  pairs.forEach((p) => {
    let repeatLabel = 'Repetida';
    const prevDate = p.repeat_of?.round?.round_date;
    if (prevDate) {
      const prevRoundNumber = roundNumberIndex.get(prevDate) || '?';
      repeatLabel = `Repetida (${formatDateBR(prevDate)} · Rodada ${prevRoundNumber})`;
    }
    list.append(
      el('div', { class: `pair-card ${p.is_repeat ? 'repeat' : ''}` }, [
        el('span', { class: 'names' }, `${p.player1.name} & ${p.player2.name}`),
        el('span', { class: `badge ${p.is_repeat ? 'badge-repeat' : 'badge-fresh'}` }, p.is_repeat ? repeatLabel : 'Inédita'),
      ])
    );
  });
  host.append(list);
}

async function renderDraftRound(host, round, category, circuit) {
  const [allPlayers, participants] = await Promise.all([getPlayers(category.id), getRoundParticipants(round.id)]);

  // garante que jogadores já selecionados (mesmo se desativados depois) apareçam
  const participantIds = new Set(participants.map((p) => p.id));
  const extraInactive = participants.filter((p) => !allPlayers.some((a) => a.id === p.id));
  const playersToShow = [...allPlayers, ...extraInactive].sort((a, b) => a.name.localeCompare(b.name));

  if (playersToShow.length === 0) {
    host.append(alertBox('warn', 'Essa categoria ainda não tem jogadores cadastrados. Cadastre em Administração → Jogadores.'));
    return;
  }

  const selectedState = new Map(playersToShow.map((p) => [p.id, participantIds.has(p.id)]));

  const listHost = el('div', { class: 'card' });
  const title = el('h3', {}, 'Jogadores presentes hoje');
  const selectAllBtn = el('button', { class: 'btn btn-sm' }, 'Selecionar todos');
  const selectNoneBtn = el('button', { class: 'btn btn-sm' }, 'Limpar seleção');

  const checklist = el('div', { class: 'list' });
  function rebuildChecklist() {
    checklist.innerHTML = '';
    playersToShow.forEach((p) => {
      const checkbox = el('input', { type: 'checkbox' });
      checkbox.checked = !!selectedState.get(p.id);
      checkbox.addEventListener('change', () => selectedState.set(p.id, checkbox.checked));
      checklist.append(el('label', { class: 'checkbox-row' }, [checkbox, p.name + (p.is_active === false ? ' (removido)' : '')]));
    });
  }
  rebuildChecklist();

  selectAllBtn.addEventListener('click', () => {
    playersToShow.forEach((p) => selectedState.set(p.id, true));
    rebuildChecklist();
    updateCount();
  });
  selectNoneBtn.addEventListener('click', () => {
    playersToShow.forEach((p) => selectedState.set(p.id, false));
    rebuildChecklist();
    updateCount();
  });

  const countLabel = el('p', { class: 'muted' });
  function updateCount() {
    const n = [...selectedState.values()].filter(Boolean).length;
    countLabel.textContent = `${n} jogador(es) selecionado(s)`;
  }
  checklist.addEventListener('change', updateCount);
  updateCount();

  const continueBtn = el('button', { class: 'btn btn-primary btn-block', style: 'margin-top:0.8rem;' }, 'Confirmar lista e continuar');
  continueBtn.addEventListener('click', async () => {
    const selectedIds = playersToShow.filter((p) => selectedState.get(p.id)).map((p) => p.id);
    if (selectedIds.length < 2) {
      alert('Selecione pelo menos 2 jogadores.');
      return;
    }
    continueBtn.disabled = true;
    try {
      await saveRoundParticipants(round.id, selectedIds);
      let sitOutId = null;
      if (selectedIds.length % 2 !== 0) {
        sitOutId = await promptSitOut(selectedIds, playersToShow);
        if (!sitOutId) {
          continueBtn.disabled = false;
          return; // admin cancelou
        }
      }
      const updated = await updateRound(round.id, { sit_out_player_id: sitOutId });
      state.currentRound.round = updated;
      listHost.remove(); // esconde a etapa de seleção, já concluída
      await renderSorteioStep(host, updated, selectedIds, playersToShow);
    } catch (err) {
      alert('Erro ao salvar seleção: ' + err.message);
      continueBtn.disabled = false;
    }
  });

  listHost.append(el('div', { class: 'row between' }, [title, el('div', { class: 'row' }, [selectAllBtn, selectNoneBtn])]), checklist, countLabel, continueBtn);
  host.append(listHost);
}

function promptSitOut(selectedIds, playersToShow) {
  return new Promise((resolve) => {
    const overlayHost = $('#round-content');
    const nameOf = (id) => playersToShow.find((p) => p.id === id)?.name || id;
    const select = el(
      'select',
      {},
      selectedIds.map((id) => el('option', { value: id }, nameOf(id)))
    );
    const card = el('div', { class: 'card' }, [
      el('h3', {}, 'Número ímpar de jogadores'),
      el('p', { class: 'muted' }, 'Escolha quem fica de fora nesta rodada:'),
      el('div', { class: 'field' }, select),
      el('div', { class: 'row' }, [
        el(
          'button',
          {
            class: 'btn btn-primary',
            onclick: () => {
              card.remove();
              resolve(select.value);
            },
          },
          'Confirmar'
        ),
        el(
          'button',
          {
            class: 'btn',
            onclick: () => {
              card.remove();
              resolve(null);
            },
          },
          'Cancelar'
        ),
      ]),
    ]);
    overlayHost.append(card);
  });
}

async function renderSorteioStep(host, round, selectedIds, playersToShow) {
  // remove qualquer conteúdo de seleção anterior e mostra a etapa do sorteio
  const nameOf = (id) => playersToShow.find((p) => p.id === id)?.name || '(desconhecido)';
  const playingIds = selectedIds.filter((id) => id !== round.sit_out_player_id);

  const stepHost = el('div', { class: 'card' });
  stepHost.append(el('h3', {}, 'Sorteio'));
  if (round.sit_out_player_id) {
    stepHost.append(el('p', { class: 'muted' }, `${nameOf(round.sit_out_player_id)} fica de fora nesta rodada.`));
  }
  stepHost.append(el('p', { class: 'muted' }, `${playingIds.length} jogadores vão sortear ${playingIds.length / 2} dupla(s).`));

  const resultHost = el('div', { class: 'stack', style: 'margin-top:0.8rem;' });
  stepHost.append(resultHost);
  host.append(stepHost);

  let draft = null; // resultado do sorteio ainda não aprovado
  let approvedHistoryRows = []; // cache da última busca de histórico (pra numerar rodadas repetidas)

  async function runDraw() {
    const ANIMATION_MS = 3000;

    resultHost.innerHTML = '';
    const spinner = el('div', { class: 'sorteio-spinner' }, '🎾');
    const label = el('div', { class: 'sorteio-label' }, 'Sorteando as duplas...');
    const shuffleList = el('div', { class: 'sorteio-shuffle-list' });
    resultHost.append(el('div', { class: 'sorteio-animation' }, [spinner, label, shuffleList]));

    // efeito visual: fica embaralhando os nomes na tela enquanto "sorteia"
    // (isso é só encenação - o resultado de verdade já está sendo
    // calculado ao mesmo tempo, no fundo)
    const shuffleTick = () => {
      const shuffled = shuffle(playingIds);
      shuffleList.innerHTML = '';
      for (let i = 0; i < shuffled.length; i += 2) {
        const b = shuffled[i + 1];
        shuffleList.append(
          el('div', { class: 'pair-card shuffling' }, el('span', { class: 'names' }, b ? `${nameOf(shuffled[i])} & ${nameOf(b)}` : nameOf(shuffled[i])))
        );
      }
    };
    shuffleTick();
    const shuffleInterval = setInterval(shuffleTick, 180);

    let result = null;
    let computeError = null;
    try {
      const [computed] = await Promise.all([
        (async () => {
          const historyRows = await getApprovedPairsHistory(state.currentRound.category.id, state.currentRound.circuit.id);
          approvedHistoryRows = historyRows;
          const historyMap = buildHistoryMap(historyRows);
          return sortearDuplas(playingIds, historyMap);
        })(),
        new Promise((resolve) => setTimeout(resolve, ANIMATION_MS)),
      ]);
      result = computed;
    } catch (err) {
      computeError = err;
    }

    clearInterval(shuffleInterval);

    if (computeError) {
      resultHost.innerHTML = '';
      resultHost.append(alertBox('error', 'Não foi possível sortear: ' + computeError.message));
      return;
    }
    draft = result;
    renderDraftResult();
  }

  function renderDraftResult() {
    resultHost.innerHTML = '';
    if (draft.repeatsUsed > 0) {
      resultHost.append(
        alertBox(
          'warn',
          `Não foi possível montar todas as duplas sem repetir. ${draft.repeatsUsed} dupla(s) precisou(aram) repetir - foi(ram) escolhida(s) a(s) que jogaram juntas há mais tempo.`
        )
      );
    } else {
      resultHost.append(alertBox('success', 'Todas as duplas são inéditas neste circuito!'));
    }

    const roundNumberIndex = buildRoundNumberIndex(approvedHistoryRows.map((h) => h.round_date));
    const list = el('div', { class: 'list' });
    draft.pairs.forEach((p) => {
      const prevRoundNumber = p.isRepeat ? roundNumberIndex.get(p.lastDate) || '?' : null;
      list.append(
        el('div', { class: `pair-card ${p.isRepeat ? 'repeat' : ''}` }, [
          el('span', { class: 'names' }, `${nameOf(p.a)} & ${nameOf(p.b)}`),
          el(
            'span',
            { class: `badge ${p.isRepeat ? 'badge-repeat' : 'badge-fresh'}` },
            p.isRepeat ? `Repetida (${formatDateBR(p.lastDate)} · Rodada ${prevRoundNumber})` : 'Inédita'
          ),
        ])
      );
    });
    resultHost.append(list);

    const actions = el('div', { class: 'row', style: 'margin-top:0.9rem;' }, [
      el('button', { class: 'btn', onclick: runDraw }, 'Sortear novamente'),
      el('button', { class: 'btn btn-primary', onclick: approveDraw }, 'Aprovar sorteio'),
    ]);
    resultHost.append(actions);
  }

  async function approveDraw() {
    if (!draft) return;
    if (!confirm('Confirmar e salvar este sorteio no histórico? Depois de aprovado não será possível sortear de novo para essa data.')) {
      return;
    }
    try {
      // busca id da última dupla igual aprovada (para rastreabilidade de repetição)
      const historyRows = await getApprovedPairsHistory(state.currentRound.category.id, state.currentRound.circuit.id);
      const rows = draft.pairs.map((p) => {
        const [player1_id, player2_id] = sortIdsPair(p.a, p.b);
        let repeat_of_pair_id = null;
        if (p.isRepeat) {
          const matches = historyRows
            .filter((h) => sortIdsPair(h.player1_id, h.player2_id).join('|') === sortIdsPair(p.a, p.b).join('|'))
            .sort((x, y) => (x.round_date < y.round_date ? 1 : -1));
          if (matches[0]) repeat_of_pair_id = matches[0].id;
        }
        return {
          round_id: round.id,
          player1_id,
          player2_id,
          is_repeat: p.isRepeat,
          repeat_of_pair_id,
        };
      });

      const { error: insErr } = await supabase.from('pairs').insert(rows);
      if (insErr) throw insErr;

      await updateRound(round.id, {
        status: 'aprovado',
        approved_by: state.profile.id,
        approved_at: new Date().toISOString(),
      });

      renderRound();
    } catch (err) {
      alert('Erro ao aprovar sorteio: ' + err.message);
    }
  }

  const discardBtn = el(
    'button',
    {
      class: 'btn btn-danger',
      style: 'margin-top:0.6rem;',
      onclick: async () => {
        if (!confirm('Descartar esta rodada (rascunho) e voltar para o início?')) return;
        try {
          await deleteRound(round.id);
          showView('home');
        } catch (err) {
          alert('Erro: ' + err.message);
        }
      },
    },
    'Descartar rascunho da rodada'
  );

  const drawBtn = el('button', { class: 'btn btn-primary btn-block' }, 'Sortear duplas');
  drawBtn.addEventListener('click', () => {
    drawBtn.remove();
    runDraw();
  });
  resultHost.append(drawBtn);
  stepHost.append(discardBtn);
}

// ============================================================
// HISTÓRICO
// ============================================================
async function renderHistory() {
  const host = $('#history-content');
  host.innerHTML = '';
  host.append(el('p', { class: 'muted' }, 'Carregando...'));

  try {
    const [circuits, categories] = await Promise.all([
      supabase.from('circuits').select('*').order('start_date', { ascending: false }).then((r) => r.data || []),
      getCategories({ onlyActive: false }),
    ]);
    const activeCircuit = circuits.find((c) => c.is_active);

    host.innerHTML = '';

    const circuitSelect = el(
      'select',
      { id: 'hist-circuit' },
      [el('option', { value: '' }, 'Todos os circuitos'), ...circuits.map((c) => el('option', { value: c.id }, c.name))]
    );
    if (state.historyPreselectCircuitId) {
      circuitSelect.value = state.historyPreselectCircuitId;
      state.historyPreselectCircuitId = null;
    } else if (activeCircuit) {
      circuitSelect.value = activeCircuit.id;
    }

    const categorySelect = el(
      'select',
      { id: 'hist-category' },
      [
        el('option', { value: '' }, 'Todas as categorias'),
        ...categories.map((c) => el('option', { value: c.id }, `${c.name}${c.circuit ? ' · ' + c.circuit.name : ''}`)),
      ]
    );

    const searchInput = el('input', { type: 'text', placeholder: 'Buscar por nome do jogador...' });

    const resultsHost = el('div', { style: 'margin-top:1rem;' });

    async function refreshResults() {
      resultsHost.innerHTML = '';
      resultsHost.append(el('p', { class: 'muted' }, 'Buscando...'));
      try {
        let q = supabase
          .from('pairs')
          .select(
            `id, is_repeat,
             player1:players!pairs_player1_id_fkey(id,name),
             player2:players!pairs_player2_id_fkey(id,name),
             round:rounds!inner(id, round_date, status, category_id, circuit_id,
               category:categories(name),
               circuit:circuits(name))`
          )
          .eq('round.status', 'aprovado');

        if (circuitSelect.value) q = q.eq('round.circuit_id', circuitSelect.value);
        if (categorySelect.value) q = q.eq('round.category_id', categorySelect.value);

        const { data, error } = await q;
        if (error) throw error;

        const allRows = data || [];

        // Numeração das rodadas: agrupa por categoria+circuito e numera
        // pela ordem cronológica das datas (feito ANTES do filtro de
        // busca por jogador, pra "Rodada N" não mudar conforme a busca).
        const dateGroups = new Map(); // "categoria|circuito" -> [datas]
        allRows.forEach((r) => {
          const key = `${r.round.category_id}|${r.round.circuit_id}`;
          if (!dateGroups.has(key)) dateGroups.set(key, []);
          dateGroups.get(key).push(r.round.round_date);
        });
        const roundNumberIndexes = new Map(); // "categoria|circuito" -> Map(data -> número)
        for (const [key, dates] of dateGroups) {
          roundNumberIndexes.set(key, buildRoundNumberIndex(dates));
        }
        function roundNumberOf(r) {
          const key = `${r.round.category_id}|${r.round.circuit_id}`;
          return roundNumberIndexes.get(key)?.get(r.round.round_date) || '?';
        }

        // PostgREST não ordena a tabela principal por coluna de tabela
        // relacionada (round.round_date), então ordenamos aqui no cliente.
        let rows = allRows.sort((a, b) => (a.round.round_date < b.round.round_date ? 1 : -1));
        const term = searchInput.value.trim().toLowerCase();
        if (term) {
          rows = rows.filter(
            (r) => r.player1.name.toLowerCase().includes(term) || r.player2.name.toLowerCase().includes(term)
          );
        }

        resultsHost.innerHTML = '';
        if (rows.length === 0) {
          resultsHost.append(alertBox('warn', 'Nenhum resultado encontrado.'));
          return;
        }

        const tableWrap = el('div', { class: 'table-wrap' });
        const table = el('table');
        table.append(
          el('thead', {}, el('tr', {}, ['Rodada', 'Data', 'Categoria', 'Circuito', 'Dupla', 'Status'].map((h) => el('th', {}, h))))
        );
        const tbody = el('tbody');
        rows.forEach((r) => {
          tbody.append(
            el('tr', {}, [
              el('td', {}, `Rodada ${roundNumberOf(r)}`),
              el('td', {}, formatDateBR(r.round.round_date)),
              el('td', {}, r.round.category?.name || ''),
              el('td', {}, r.round.circuit?.name || ''),
              el('td', {}, `${r.player1.name} & ${r.player2.name}`),
              el('td', {}, el('span', { class: `badge ${r.is_repeat ? 'badge-repeat' : 'badge-fresh'}` }, r.is_repeat ? 'Repetida' : 'Inédita')),
            ])
          );
        });
        table.append(tbody);
        tableWrap.append(table);
        resultsHost.append(tableWrap);
      } catch (err) {
        resultsHost.innerHTML = '';
        resultsHost.append(alertBox('error', 'Erro: ' + err.message));
      }
    }

    [circuitSelect, categorySelect].forEach((s) => s.addEventListener('change', refreshResults));
    let searchTimeout;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(refreshResults, 300);
    });

    host.append(
      el('div', { class: 'card' }, [
        el('h3', {}, 'Filtros'),
        el('div', { class: 'field' }, [el('label', {}, 'Circuito'), circuitSelect]),
        el(
          'p',
          { class: 'muted', style: 'margin:-0.3rem 0 0.6rem;' },
          'Encerrar um circuito não apaga nada: escolha-o aqui (ou "Todos os circuitos") pra ver o histórico dele.'
        ),
        el('div', { class: 'field' }, [el('label', {}, 'Categoria'), categorySelect]),
        el('div', { class: 'field' }, [el('label', {}, 'Jogador'), searchInput]),
      ]),
      resultsHost
    );

    await refreshResults();
    await renderConferenceTool(host, categories);
  } catch (err) {
    console.error(err);
    host.innerHTML = '';
    host.append(alertBox('error', 'Erro ao carregar histórico: ' + err.message));
  }
}

async function renderConferenceTool(host, categories) {
  const allPlayersByCategory = await Promise.all(
    categories.map(async (c) => ({ category: c, players: await getPlayers(c.id, { onlyActive: false }) }))
  );

  function buildPlayerSelect() {
    return el(
      'select',
      {},
      allPlayersByCategory
        .filter((g) => g.players.length > 0)
        .map((g) => el('optgroup', { label: g.category.name }, g.players.map((p) => el('option', { value: p.id }, p.name))))
    );
  }

  const selectA = buildPlayerSelect();
  const selectB = buildPlayerSelect();
  const resultHost = el('div', { style: 'margin-top:0.8rem;' });

  const checkBtn = el('button', { class: 'btn btn-primary' }, 'Verificar');
  checkBtn.addEventListener('click', async () => {
    resultHost.innerHTML = '';
    if (selectA.value === selectB.value) {
      resultHost.append(alertBox('warn', 'Escolha dois jogadores diferentes.'));
      return;
    }
    resultHost.append(el('p', { class: 'muted' }, 'Verificando...'));
    try {
      const [p1, p2] = sortIdsPair(selectA.value, selectB.value);
      const { data, error } = await supabase
        .from('pairs')
        .select(
          `id, round:rounds!inner(round_date, status, category:categories(name), circuit:circuits(name))`
        )
        .eq('round.status', 'aprovado')
        .eq('player1_id', p1)
        .eq('player2_id', p2);
      if (error) throw error;

      // ordena no cliente (PostgREST não ordena a tabela principal por
      // coluna de uma tabela relacionada)
      const rows = (data || []).sort((a, b) => (a.round.round_date < b.round.round_date ? 1 : -1));

      resultHost.innerHTML = '';
      const nameA = selectA.options[selectA.selectedIndex].textContent;
      const nameB = selectB.options[selectB.selectedIndex].textContent;
      if (rows.length === 0) {
        resultHost.append(alertBox('success', `${nameA} e ${nameB} nunca formaram dupla (no filtro atual).`));
        return;
      }
      resultHost.append(alertBox('warn', `${nameA} e ${nameB} já jogaram juntos ${rows.length} vez(es):`));
      const list = el('div', { class: 'list' });
      rows.forEach((r) => {
        list.append(
          el('div', { class: 'list-item' }, [
            `${formatDateBR(r.round.round_date)} · ${r.round.category?.name || ''}`,
            el('span', { class: 'muted' }, r.round.circuit?.name || ''),
          ])
        );
      });
      resultHost.append(list);
    } catch (err) {
      resultHost.innerHTML = '';
      resultHost.append(alertBox('error', 'Erro: ' + err.message));
    }
  });

  host.append(
    el('div', { class: 'card' }, [
      el('h3', {}, 'Já jogaram juntos? (conferência)'),
      el('div', { class: 'row' }, [
        el('div', { class: 'field', style: 'flex:1;min-width:140px;' }, [el('label', {}, 'Jogador 1'), selectA]),
        el('div', { class: 'field', style: 'flex:1;min-width:140px;' }, [el('label', {}, 'Jogador 2'), selectB]),
      ]),
      checkBtn,
      resultHost,
    ])
  );
}

// ============================================================
// ADMIN
// ============================================================
function setupAdminTabs() {
  $all('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $all('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderAdmin(btn.dataset.adminTab);
    });
  });
}

async function renderAdmin(tab) {
  const host = $('#admin-content');
  host.innerHTML = '';
  host.append(el('p', { class: 'muted' }, 'Carregando...'));
  try {
    if (tab === 'circuitos') await renderAdminCircuitos(host);
    else if (tab === 'categorias') await renderAdminCategorias(host);
    else if (tab === 'jogadores') await renderAdminJogadores(host);
  } catch (err) {
    host.innerHTML = '';
    host.append(alertBox('error', 'Erro: ' + err.message));
  }
}

async function renderAdminCircuitos(host) {
  const circuits = await getCircuits();
  host.innerHTML = '';

  const list = el('div', { class: 'list' });
  circuits.forEach((c) => {
    list.append(
      el('div', { class: 'list-item' }, [
        el('div', {}, [
          el('div', {}, c.name),
          el('span', { class: 'muted' }, `${formatDateBR(c.start_date)}${c.end_date ? ' → ' + formatDateBR(c.end_date) : ''}`),
        ]),
        el('div', { class: 'row' }, [
          el('span', { class: `badge ${c.is_active ? 'badge-fresh' : 'badge-repeat'}` }, c.is_active ? 'Ativo' : 'Encerrado'),
          el(
            'button',
            {
              class: 'btn btn-sm',
              onclick: async () => {
                const novoNome = prompt('Novo nome do circuito:', c.name);
                if (novoNome === null) return;
                const trimmed = novoNome.trim();
                if (!trimmed) {
                  alert('O nome não pode ficar em branco.');
                  return;
                }
                try {
                  const { error: updErr } = await supabase.from('circuits').update({ name: trimmed }).eq('id', c.id);
                  if (updErr) throw updErr;
                  renderAdmin('circuitos');
                } catch (err) {
                  alert('Erro: ' + err.message);
                }
              },
            },
            'Renomear'
          ),
          el(
            'button',
            {
              class: 'btn btn-sm',
              onclick: () => {
                state.historyPreselectCircuitId = c.id;
                showView('history');
              },
            },
            'Ver histórico'
          ),
          c.is_active
            ? el(
                'button',
                {
                  class: 'btn btn-sm',
                  onclick: async () => {
                    const ok = confirm(
                      `Encerrar o circuito "${c.name}"? Ele para de aparecer para novos sorteios, mas todo o histórico continua salvo (dá pra consultar em "Ver histórico" e, se precisar, excluir depois).`
                    );
                    if (!ok) return;
                    try {
                      const { error } = await supabase
                        .from('circuits')
                        .update({ is_active: false, end_date: todayISO() })
                        .eq('id', c.id);
                      if (error) throw error;
                      renderAdmin('circuitos');
                    } catch (err) {
                      alert('Erro: ' + err.message);
                    }
                  },
                },
                'Encerrar'
              )
            : null,
          !c.is_active
            ? el(
                'button',
                {
                  class: 'btn btn-sm btn-danger',
                  onclick: async () => {
                    const ok = confirmDelete(
                      `o circuito "${c.name}"`,
                      'Isso remove TODO o histórico dele: rodadas, duplas, categorias e jogadores.'
                    );
                    if (!ok) return;
                    try {
                      const { error: delRoundsErr } = await supabase.from('rounds').delete().eq('circuit_id', c.id);
                      if (delRoundsErr) throw delRoundsErr;
                      const { error: delCircuitErr } = await supabase.from('circuits').delete().eq('id', c.id);
                      if (delCircuitErr) throw delCircuitErr;
                      renderAdmin('circuitos');
                    } catch (err) {
                      alert('Erro: ' + err.message);
                    }
                  },
                },
                'Excluir'
              )
            : null,
        ]),
      ])
    );
  });

  const nameInput = el('input', { type: 'text', placeholder: 'Ex: Circuito 2026.2' });
  const dateInput = el('input', { type: 'date', value: todayISO() });

  const createBtn = el('button', { class: 'btn btn-primary btn-block' }, 'Criar novo circuito');
  createBtn.addEventListener('click', async () => {
    if (!nameInput.value.trim()) {
      alert('Dê um nome ao circuito.');
      return;
    }
    try {
      const { error: insErr } = await supabase
        .from('circuits')
        .insert({ name: nameInput.value.trim(), start_date: dateInput.value, is_active: true });
      if (insErr) throw insErr;
      nameInput.value = '';
      renderAdmin('circuitos');
    } catch (err) {
      alert('Erro: ' + err.message);
    }
  });

  host.append(
    el('div', { class: 'card' }, [el('h3', {}, 'Circuitos'), list]),
    el('div', { class: 'card' }, [
      el('h3', {}, 'Novo circuito'),
      el(
        'p',
        { class: 'muted', style: 'margin:-0.3rem 0 0.8rem;' },
        'Dá pra ter mais de um circuito ativo ao mesmo tempo - útil se você roda circuitos em paralelo. Criar um novo não encerra os outros.'
      ),
      el('div', { class: 'field' }, [el('label', {}, 'Nome'), nameInput]),
      el('div', { class: 'field' }, [el('label', {}, 'Data de início'), dateInput]),
      createBtn,
    ])
  );
}

async function renderAdminCategorias(host) {
  const [circuits, activeCircuits, categories] = await Promise.all([
    getCircuits(),
    getCircuits({ onlyActive: true }),
    getCategories({ onlyActive: false }),
  ]);
  host.innerHTML = '';

  const filterSelect = el('select', { id: 'cat-filter-circuit' }, [
    el('option', { value: '' }, 'Todos os circuitos'),
    ...circuits.map((ci) => el('option', { value: ci.id }, `${ci.name}${ci.is_active ? '' : ' (encerrado)'}`)),
  ]);

  const listHost = el('div', { class: 'list' });

  function renderList() {
    listHost.innerHTML = '';
    const filtered = filterSelect.value ? categories.filter((c) => c.circuit_id === filterSelect.value) : categories;
    if (filtered.length === 0) {
      listHost.append(el('p', { class: 'muted' }, 'Nenhuma categoria encontrada.'));
      return;
    }
    filtered.forEach((c) => {
      const circuitMoveSelect = el(
        'select',
        { style: 'width:auto;' },
        circuits.map((ci) => el('option', { value: ci.id }, `${ci.name}${ci.is_active ? '' : ' (encerrado)'}`))
      );
      circuitMoveSelect.value = c.circuit_id;
      circuitMoveSelect.addEventListener('change', async () => {
        const novoCircuito = circuits.find((ci) => ci.id === circuitMoveSelect.value);
        const ok = confirm(`Mover a categoria "${c.name}" para o circuito "${novoCircuito.name}"?`);
        if (!ok) {
          circuitMoveSelect.value = c.circuit_id;
          return;
        }
        try {
          const { error: updErr } = await supabase
            .from('categories')
            .update({ circuit_id: circuitMoveSelect.value })
            .eq('id', c.id);
          if (updErr) throw updErr;
          renderAdmin('categorias');
        } catch (err) {
          alert('Erro: ' + err.message);
          circuitMoveSelect.value = c.circuit_id;
        }
      });

      listHost.append(
        el('div', { class: 'list-item' }, [
          el('div', {}, [
            el('div', {}, `${c.name} · ${genderLabel(c.gender)}`),
            el('span', { class: 'muted' }, `${WEEKDAY_NAMES[c.weekday]} · ${c.circuit?.name || '(circuito removido)'}`),
          ]),
          el('div', { class: 'row' }, [
            circuitMoveSelect,
            el(
              'button',
              {
                class: 'btn btn-sm',
                onclick: async () => {
                  const novoNome = prompt('Novo nome da categoria:', c.name);
                  if (novoNome === null) return;
                  const trimmed = novoNome.trim();
                  if (!trimmed) {
                    alert('O nome não pode ficar em branco.');
                    return;
                  }
                  try {
                    const { error: updErr } = await supabase.from('categories').update({ name: trimmed }).eq('id', c.id);
                    if (updErr) throw updErr;
                    renderAdmin('categorias');
                  } catch (err) {
                    alert('Erro: ' + err.message);
                  }
                },
              },
              'Editar nome'
            ),
            el(
              'button',
              {
                class: 'btn btn-sm',
                onclick: async () => {
                  await supabase.from('categories').update({ is_active: !c.is_active }).eq('id', c.id);
                  renderAdmin('categorias');
                },
              },
              c.is_active ? 'Desativar' : 'Reativar'
            ),
            el(
              'button',
              {
                class: 'btn btn-sm btn-danger',
                onclick: async () => {
                  const ok = confirmDelete(
                    `a categoria "${c.name}"`,
                    'Isso também remove os jogadores cadastrados nela.'
                  );
                  if (!ok) return;
                  try {
                    const { error: delErr } = await supabase.from('categories').delete().eq('id', c.id);
                    if (delErr) throw delErr;
                    renderAdmin('categorias');
                  } catch (err) {
                    if (String(err.message).toLowerCase().includes('foreign key') || err.code === '23503') {
                      alert(
                        'Não é possível excluir esta categoria porque ela já tem rodadas no histórico. Desative-a em vez de excluir.'
                      );
                    } else {
                      alert('Erro: ' + err.message);
                    }
                  }
                },
              },
              'Excluir'
            ),
          ]),
        ])
      );
    });
  }

  filterSelect.addEventListener('change', renderList);
  renderList();

  let createCard;
  if (activeCircuits.length === 0) {
    createCard = el('div', { class: 'card' }, [
      el('h3', {}, 'Nova categoria'),
      alertBox('warn', 'Crie um circuito ativo em Administração → Circuitos antes de cadastrar uma categoria.'),
    ]);
  } else {
    const circuitCreateSelect = el(
      'select',
      { id: 'cat-create-circuit' },
      activeCircuits.map((ci) => el('option', { value: ci.id }, ci.name))
    );
    const nameInput = el('input', { type: 'text', placeholder: 'Ex: Masculino B' });
    const genderSelect = el('select', { id: 'cat-create-gender' }, [
      el('option', { value: 'masculino' }, 'Masculino'),
      el('option', { value: 'feminino' }, 'Feminino'),
    ]);
    const weekdaySelect = el(
      'select',
      { id: 'cat-create-weekday' },
      WEEKDAY_NAMES.map((n, i) => el('option', { value: i }, n))
    );

    const createBtn = el('button', { class: 'btn btn-primary btn-block' }, 'Adicionar categoria');
    createBtn.addEventListener('click', async () => {
      if (!nameInput.value.trim()) {
        alert('Dê um nome à categoria.');
        return;
      }
      try {
        const { error: insErr } = await supabase.from('categories').insert({
          circuit_id: circuitCreateSelect.value,
          name: nameInput.value.trim(),
          gender: genderSelect.value,
          weekday: Number(weekdaySelect.value),
        });
        if (insErr) throw insErr;
        nameInput.value = '';
        renderAdmin('categorias');
      } catch (err) {
        alert('Erro: ' + err.message);
      }
    });

    createCard = el('div', { class: 'card' }, [
      el('h3', {}, 'Nova categoria'),
      el('div', { class: 'field' }, [el('label', {}, 'Circuito'), circuitCreateSelect]),
      el('div', { class: 'field' }, [el('label', {}, 'Nome'), nameInput]),
      el('div', { class: 'field' }, [el('label', {}, 'Gênero'), genderSelect]),
      el('div', { class: 'field' }, [el('label', {}, 'Dia da semana da rodada'), weekdaySelect]),
      createBtn,
    ]);
  }

  host.append(
    el('div', { class: 'card' }, [
      el('h3', {}, 'Categorias cadastradas'),
      el('div', { class: 'field' }, [el('label', {}, 'Filtrar por circuito'), filterSelect]),
      listHost,
    ]),
    createCard
  );
}

async function renderAdminJogadores(host) {
  const categories = await getCategories({ onlyActive: false });
  host.innerHTML = '';

  if (categories.length === 0) {
    host.append(alertBox('warn', 'Cadastre uma categoria primeiro, na aba Categorias.'));
    return;
  }

  const catSelect = el(
    'select',
    {},
    categories.map((c) => el('option', { value: c.id }, `${c.name}${c.circuit ? ' · ' + c.circuit.name : ''}`))
  );
  const listHost = el('div');
  let showRemoved = false;

  async function refreshList() {
    listHost.innerHTML = '';
    listHost.append(el('p', { class: 'muted' }, 'Carregando...'));
    const players = await getPlayers(catSelect.value, { onlyActive: false });
    players.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
    listHost.innerHTML = '';
    const visiblePlayers = showRemoved ? players : players.filter((p) => p.is_active);

    const list = el('div', { class: 'list' });
    if (visiblePlayers.length === 0) {
      list.append(
        el(
          'p',
          { class: 'muted' },
          showRemoved ? 'Nenhum jogador nesta categoria ainda.' : 'Nenhum jogador ativo nesta categoria ainda.'
        )
      );
    }
    visiblePlayers.forEach((p) => {
      list.append(
        el('div', { class: 'list-item' }, [
          el('div', {}, p.name + (p.is_active ? '' : ' (removido)')),
          el('div', { class: 'row' }, [
            el(
              'button',
              {
                class: 'btn btn-sm',
                onclick: async () => {
                  const novoNome = prompt('Novo nome do jogador:', p.name);
                  if (novoNome === null) return;
                  const trimmed = novoNome.trim();
                  if (!trimmed) {
                    alert('O nome não pode ficar em branco.');
                    return;
                  }
                  try {
                    const { error: updErr } = await supabase.from('players').update({ name: trimmed }).eq('id', p.id);
                    if (updErr) throw updErr;
                    refreshList();
                  } catch (err) {
                    alert('Erro: ' + err.message);
                  }
                },
              },
              'Editar nome'
            ),
            p.is_active
              ? el(
                  'button',
                  {
                    class: 'btn btn-sm btn-danger',
                    onclick: async () => {
                      const ok = confirmDelete(`o jogador "${p.name}"`);
                      if (!ok) return;
                      try {
                        const { error: delErr } = await supabase.from('players').delete().eq('id', p.id);
                        if (delErr) throw delErr;
                        refreshList();
                      } catch (err) {
                        if (String(err.message).toLowerCase().includes('foreign key') || err.code === '23503') {
                          await supabase.from('players').update({ is_active: false }).eq('id', p.id);
                          alert(
                            `"${p.name}" já tem duplas no histórico, então não dá pra apagar por completo (isso estragaria o histórico). Ele foi removido das listas de seleção.`
                          );
                          refreshList();
                        } else {
                          alert('Erro: ' + err.message);
                        }
                      }
                    },
                  },
                  'Excluir'
                )
              : el(
                  'button',
                  {
                    class: 'btn btn-sm',
                    onclick: async () => {
                      await supabase.from('players').update({ is_active: true }).eq('id', p.id);
                      refreshList();
                    },
                  },
                  'Reativar'
                ),
          ]),
        ])
      );
    });
    listHost.append(list);
  }

  catSelect.addEventListener('change', refreshList);

  const showRemovedCheckbox = el('input', { type: 'checkbox' });
  showRemovedCheckbox.addEventListener('change', () => {
    showRemoved = showRemovedCheckbox.checked;
    refreshList();
  });
  const showRemovedLabel = el('label', { class: 'row', style: 'gap:0.4rem; margin-top:0.6rem; cursor:pointer;' }, [
    showRemovedCheckbox,
    el('span', { class: 'muted' }, 'Mostrar jogadores removidos'),
  ]);

  const nameInput = el('input', { type: 'text', placeholder: 'Nome do jogador' });
  const addBtn = el('button', { class: 'btn btn-primary btn-block' }, 'Adicionar jogador');

  async function addPlayer() {
    if (!nameInput.value.trim()) return;
    try {
      const { error: insErr } = await supabase
        .from('players')
        .insert({ category_id: catSelect.value, name: nameInput.value.trim() });
      if (insErr) throw insErr;
      nameInput.value = '';
      nameInput.focus();
      refreshList();
    } catch (err) {
      alert('Erro: ' + err.message);
    }
  }

  addBtn.addEventListener('click', addPlayer);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addPlayer();
    }
  });

  host.append(
    el('div', { class: 'card' }, [
      el('h3', {}, 'Categoria'),
      catSelect,
    ]),
    el('div', { class: 'card' }, [
      el('h3', {}, 'Adicionar jogador'),
      el('div', { class: 'field' }, [el('label', {}, 'Nome'), nameInput]),
      addBtn,
    ]),
    el('div', { class: 'card' }, [el('h3', {}, 'Jogadores'), listHost, showRemovedLabel])
  );

  await refreshList();
}

// ============================================================
// Boot
// ============================================================
setupAdminTabs();
bootstrapAuth();
