// ===================================================================
// Shared constants (mirrors the main expansion-draft-site logic so AI
// behavior is consistent across both tools)
// ===================================================================
const FLEX_POS = new Set(["RB","WR","TE"]);
function normName(s){
  return s.toLowerCase().replace(/[.'-]/g, '').replace(/\s+/g, ' ').trim();
}
const STARTING_QBS = new Set([
  'sam darnold','drake maye','jordan love','kirk cousins','daniel jones','jacoby brissett','aaron rodgers','geno smith',
  'kyler murray','joe burrow','patrick mahomes','josh allen','lamar jackson',
  'cam ward','malik willis','bo nix','justin herbert','deshaun watson',
  'cj stroud','trevor lawrence','dak prescott','jaxson dart','jalen hurts',
  'jayden daniels','matthew stafford','brock purdy','caleb williams','jared goff',
  'tua tagovailoa','tyler shough','baker mayfield','bryce young',
].map(normName));
function isStarterQB(p){
  return p.pos === 'QB' && STARTING_QBS.has(normName(p.name));
}
const QB_NEED_TARGET = 3;
const QB_NEED_BOOST = 1.3;

// General positional need: beyond the QB-specific scarcity logic above,
// AI teams also lean toward whichever position they're thinnest at overall
// (e.g. a team that kept mostly WRs in their top 12 should prioritize RB
// depth here). Targets are rough bench-relevant depth for a 29-man roster,
// not just starters.
const POSITION_TARGETS = { RB: 6, WR: 7, TE: 2 };
const POSITION_NEED_BOOST = 1.15;

const TOTAL_ROUNDS = 17;
const NUM_TEAMS = 12;
const PICK_SECONDS = 60;

// ===================================================================
// Global state
// ===================================================================
const state = {
  userTeam: null,
  orderMode: 'random',
  order: [],          // array of team names, draft order
  teams: {},          // name -> { name, isExpansion, baseline: [...], drafted: [...], totalValue }
  pool: [],           // mutable remaining pool
  round: 1,
  pickWithinRound: 0,
  pickNo: 0,
  timerInterval: null,
  timeLeft: PICK_SECONDS,
  // filters
  snakeFilter: 'ALL', snakeSearch: '',
};


// ===================================================================
// Setup screen
// ===================================================================
const teamSelect = document.getElementById('teamSelect');
const orderGroup = document.getElementById('orderGroup');
const startBtn = document.getElementById('startBtn');
const setupNote = document.getElementById('setupNote');
const simulateBtn = document.getElementById('simulateBtn');

TEAMS12.slice().sort((a,b)=>b.totalValue - a.totalValue).forEach(t => {
  const opt = document.createElement('option');
  opt.value = t.name;
  opt.textContent = `${t.name}${t.isExpansion ? ' (Expansion)' : ''} — value ${Math.round(t.totalValue).toLocaleString()}`;
  teamSelect.appendChild(opt);
});

function wireRadioGroup(group, onChange){
  group.querySelectorAll('.radio-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      group.querySelectorAll('.radio-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(btn.dataset.val);
    });
  });
}
wireRadioGroup(orderGroup, v => state.orderMode = v);

setupNote.textContent = `Pool for this draft: ${POOL17.length} players left over after all 12 teams keep their 12. ${NUM_TEAMS} teams \u00d7 ${TOTAL_ROUNDS} rounds = ${NUM_TEAMS*TOTAL_ROUNDS} slots \u2014 since that's more than the pool holds, the draft ends early once the pool runs dry rather than forcing a full ${TOTAL_ROUNDS} rounds for everyone.`;

startBtn.addEventListener('click', () => {
  state.userTeam = teamSelect.value;
  initializeDraft();
});

simulateBtn.addEventListener('click', () => {
  state.userTeam = teamSelect.value;
  simulateEntireDraft();
});

// ===================================================================
// Initialization
// ===================================================================
function setupTeamsAndOrder(){
  TEAMS12.forEach(t => {
    state.teams[t.name] = {
      name: t.name,
      isExpansion: t.isExpansion,
      baseline: t.roster,
      drafted: [],
    };
  });

  let names = TEAMS12.map(t => t.name);
  if (state.orderMode === 'random'){
    for (let i = names.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [names[i], names[j]] = [names[j], names[i]];
    }
  } else {
    names = TEAMS12.slice().sort((a,b) => a.totalValue - b.totalValue).map(t => t.name);
  }
  state.order = names;
  state.pool = POOL17.slice();
}

function initializeDraft(){
  setupTeamsAndOrder();
  document.getElementById('setupScreen').classList.add('hidden');
  document.getElementById('snakeScreen').classList.add('active');
  startSnakeDraft();
}

// Plays every pick for all 12 teams instantly (including the user's own
// team) using the same need-aware AI logic as the opponents, then jumps
// straight to the final rosters. For anyone who just wants to see what
// they'd plausibly end up with, without sitting through the full clock.
function simulateEntireDraft(){
  setupTeamsAndOrder();
  document.getElementById('setupScreen').classList.add('hidden');

  let round = 1, pickWithinRound = 0;
  while (round <= TOTAL_ROUNDS && state.pool.length > 0){
    const roundOrder = (round % 2 === 1) ? state.order : state.order.slice().reverse();
    const teamName = roundOrder[pickWithinRound];
    const team = state.teams[teamName];
    const pick = aiBestPick(team, state.pool, p => p.value);
    if (pick){
      const idx = state.pool.findIndex(p => p.name === pick.name);
      state.pool.splice(idx, 1);
      team.drafted.push(pick);
    }
    pickWithinRound++;
    if (pickWithinRound >= NUM_TEAMS){
      pickWithinRound = 0;
      round++;
    }
  }
  showEndScreen();
}

function teamQbCount(team){
  return team.baseline.filter(isStarterQB).length + team.drafted.filter(isStarterQB).length;
}

function teamPosCount(team, pos){
  return team.baseline.filter(p => p.pos === pos).length + team.drafted.filter(p => p.pos === pos).length;
}

function aiEffectiveValue(p, team, valuator){
  let v = valuator(p);
  // Real-starter QB scarcity — strong boost, since this is a 2-QB league.
  if (isStarterQB(p) && teamQbCount(team) < QB_NEED_TARGET) v *= QB_NEED_BOOST;
  // General positional need — milder boost toward whichever position a
  // team is thinnest at overall (kept-12 + drafted so far combined).
  const target = POSITION_TARGETS[p.pos];
  if (target != null && teamPosCount(team, p.pos) < target) v *= POSITION_NEED_BOOST;
  v *= (0.94 + Math.random() * 0.12); // small jitter so AI isn't perfectly robotic
  return v;
}

function aiBestPick(team, pool, valuator){
  let best = null, bestVal = -Infinity;
  for (const p of pool){
    const ev = aiEffectiveValue(p, team, valuator);
    if (ev > bestVal){ bestVal = ev; best = p; }
  }
  return best;
}

// ===================================================================
// SNAKE DRAFT ENGINE
// ===================================================================
function currentSnakeTeamName(){
  const roundOrder = (state.round % 2 === 1) ? state.order : state.order.slice().reverse();
  return roundOrder[state.pickWithinRound];
}

function advanceSnakePick(){
  clearInterval(state.timerInterval);
  state.pickWithinRound++;
  state.pickNo++;
  if (state.pickWithinRound >= NUM_TEAMS){
    state.pickWithinRound = 0;
    state.round++;
  }
  if (state.round > TOTAL_ROUNDS || state.pool.length === 0){
    endSnakeDraft();
    return;
  }
  runSnakePick();
}

function draftPlayerSnake(teamName, player){
  const team = state.teams[teamName];
  const idx = state.pool.findIndex(p => p.name === player.name);
  if (idx === -1) return;
  state.pool.splice(idx, 1);
  team.drafted.push(player);
  logSnake(teamName, player);
}

function logSnake(teamName, player){
  const log = document.getElementById('snakeLog');
  const li = document.createElement('li');
  const isYou = teamName === state.userTeam;
  if (isYou) li.className = 'you';
  const round = state.round;
  const overallPick = state.pickNo + 1;
  const pickTag = `${round}.${String((overallPick-1)%NUM_TEAMS+1).padStart(2,'0')}`;
  const line = `<span class="pick-tag">${pickTag}</span> ${teamName}${isYou?' (you)':''} selects <strong>${player.name}</strong> <span style="color:var(--text-faint)">(${player.pos})</span>`;
  li.innerHTML = line;
  log.insertBefore(li, log.firstChild);

  const banner = document.getElementById('snakeLastPick');
  banner.classList.toggle('you', isYou);
  banner.querySelector('.lp-content').innerHTML = line;
}

function runSnakePick(){
  const teamName = currentSnakeTeamName();
  document.getElementById('snakePickIndicator').textContent = `Round ${state.round}, Pick ${state.pickWithinRound+1} (overall ${state.pickNo+1})`;
  const onClockEl = document.getElementById('snakeOnClock');
  onClockEl.textContent = `On the clock: ${teamName}${teamName===state.userTeam ? ' (YOU)' : ''}`;
  onClockEl.className = 'on-clock' + (teamName === state.userTeam ? ' you' : '');

  renderSnakePool();
  renderSnakeYourRoster();

  if (teamName === state.userTeam){
    startSnakeTimer();
  } else {
    document.getElementById('snakeTimer').classList.add('hidden');
    setTimeout(() => {
      const team = state.teams[teamName];
      const pick = aiBestPick(team, state.pool, p => p.value);
      if (pick) draftPlayerSnake(teamName, pick);
      advanceSnakePick();
    }, 450 + Math.random()*350);
  }
}

function startSnakeTimer(){
  const timerEl = document.getElementById('snakeTimer');
  timerEl.classList.remove('hidden');
  state.timeLeft = PICK_SECONDS;
  timerEl.textContent = state.timeLeft;
  timerEl.classList.remove('danger');
  clearInterval(state.timerInterval);
  state.timerInterval = setInterval(() => {
    state.timeLeft--;
    timerEl.textContent = state.timeLeft;
    if (state.timeLeft <= 10) timerEl.classList.add('danger');
    if (state.timeLeft <= 0){
      clearInterval(state.timerInterval);
      // auto-pick best available for the user
      const team = state.teams[state.userTeam];
      const pick = aiBestPick(team, state.pool, p => p.value);
      if (pick) draftPlayerSnake(state.userTeam, pick);
      advanceSnakePick();
    }
  }, 1000);
}

function startSnakeDraft(){
  state.round = 1; state.pickWithinRound = 0; state.pickNo = 0;
  document.getElementById('snakeLog').innerHTML = '';
  runSnakePick();
}

function renderSnakeYourRoster(){
  const team = state.teams[state.userTeam];
  const list = document.getElementById('snakeYourRoster');
  document.getElementById('snakeYourCount').textContent = `${team.drafted.length} drafted`;

  const needsRow = document.getElementById('snakeNeeds');
  const qbCount = teamQbCount(team);
  const qbShort = qbCount < QB_NEED_TARGET;
  let needsHtml = `<span class="need-tag${qbShort?' short':''}">QB (real starters): ${qbCount}/${QB_NEED_TARGET}</span>`;
  Object.entries(POSITION_TARGETS).forEach(([pos, target]) => {
    const count = teamPosCount(team, pos);
    const short = count < target;
    needsHtml += `<span class="need-tag${short?' short':''}">${pos}: ${count}/${target}</span>`;
  });
  needsRow.innerHTML = needsHtml;

  list.innerHTML = '';
  team.drafted.slice().reverse().forEach((p,i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="slotnum mono">${team.drafted.length-i}</span><span class="pname">${isStarterQB(p)?'<span class=\"qb-star\">\u2736</span>':''}${p.name}</span><span class="ptag tag-${p.pos}">${p.pos}</span><span class="pval mono">${Math.round(p.value)}</span>`;
    list.appendChild(li);
  });
}

function renderSnakePool(){
  const isUserTurn = currentSnakeTeamName() === state.userTeam;
  const body = document.getElementById('snakePoolBody');
  let filtered = state.pool;
  if (state.snakeFilter !== 'ALL') filtered = filtered.filter(p => p.pos === state.snakeFilter);
  if (state.snakeSearch) filtered = filtered.filter(p => p.name.toLowerCase().includes(state.snakeSearch));
  filtered = filtered.slice().sort((a,b) => b.value - a.value);
  document.getElementById('snakePoolCount').textContent = `${filtered.length} shown / ${state.pool.length} left`;
  body.innerHTML = '';
  filtered.forEach(p => {
    const tr = document.createElement('tr');
    const star = isStarterQB(p) ? '<span class="qb-star" title="NFL starting QB">\u2736</span>' : '';
    tr.innerHTML = `
      <td>${p.name}</td>
      <td>${star}<span class="ptag tag-${p.pos}">${p.pos}</span></td>
      <td style="color:var(--text-faint);font-size:12px;">${p.team||'—'}</td>
      <td class="mono" style="text-align:right;color:var(--gold-dim);">${Math.round(p.value)}</td>
      <td><button class="draft-btn" ${isUserTurn?'':'disabled'} data-name="${p.name}">Draft</button></td>
    `;
    body.appendChild(tr);
  });
  body.querySelectorAll('.draft-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (currentSnakeTeamName() !== state.userTeam) return;
      const player = state.pool.find(p => p.name === btn.dataset.name);
      if (!player) return;
      draftPlayerSnake(state.userTeam, player);
      advanceSnakePick();
    });
  });
}

document.getElementById('snakeSearch').addEventListener('input', (e) => {
  state.snakeSearch = e.target.value.toLowerCase();
  renderSnakePool();
});
document.querySelectorAll('#snakeScreen .pos-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#snakeScreen .pos-filter-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    state.snakeFilter = btn.dataset.f;
    renderSnakePool();
  });
});

function endSnakeDraft(){
  clearInterval(state.timerInterval);
  document.getElementById('snakeScreen').classList.remove('active');
  showEndScreen();
}

// ===================================================================
// Shared end screen
// ===================================================================
function showEndScreen(){
  document.getElementById('endScreen').classList.add('active');
  const summary = document.getElementById('endSummary');
  const rows = Object.values(state.teams).map(t => {
    const totalVal = t.baseline.reduce((s,p) => s + p.value, 0) + t.drafted.reduce((s,p) => s + p.value, 0);
    return { team: t, name: t.name, totalVal, draftedCount: t.drafted.length, isUser: t.name === state.userTeam };
  }).sort((a,b) => b.totalVal - a.totalVal);

  let html = '<table style="max-width:600px;margin:0 auto 40px;"><thead><tr><th style="text-align:left;">Team</th><th style="text-align:center;">Picked</th><th style="text-align:right;">Final Value</th></tr></thead><tbody>';
  rows.forEach((r,i) => {
    html += `<tr style="${r.isUser?'color:var(--gold);font-weight:600;':''}"><td style="text-align:left;">${i+1}. ${r.name}${r.isUser?' (you)':''}</td><td style="text-align:center;" class="mono">${r.draftedCount}</td><td style="text-align:right;" class="mono">${Math.round(r.totalVal).toLocaleString()}</td></tr>`;
  });
  html += '</tbody></table>';

  html += '<h3 style="text-transform:uppercase;font-size:16px;margin-bottom:16px;">Final Rosters</h3>';
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;text-align:left;">';
  rows.forEach(r => {
    const full = r.team.baseline.concat(r.team.drafted).slice().sort((a,b) => b.value - a.value);
    html += `<div class="panel" style="${r.isUser?'border-color:var(--gold);':''}">`;
    html += `<div class="panel-head" style="${r.isUser?'color:var(--gold);':''}">${r.name}${r.isUser?' (you)':''} <span class="mono" style="font-size:11px;color:var(--text-faint);">${full.length} players</span></div>`;
    html += '<div class="panel-body"><ul class="roster-list" style="max-height:none;">';
    full.forEach((p,i) => {
      const star = isStarterQB(p) ? '<span class="qb-star">\u2736</span>' : '';
      const priceTag = Math.round(p.value);
      html += `<li><span class="slotnum mono">${i+1}</span><span class="pname">${star}${p.name}</span><span class="ptag tag-${p.pos}">${p.pos}</span><span class="pval mono">${priceTag}</span></li>`;
    });
    html += '</ul></div></div>';
  });
  html += '</div>';

  summary.innerHTML = html;
}

// ===================================================================
// Mobile tab bar (Available / My Team / Log)
// On desktop the .tab-panel elements are just always visible in their
// normal grid position; below 900px only the active one shows, switched
// via these tabs instead of relying on scroll position.
// ===================================================================
function setupTabs(tabBarEl){
  if (!tabBarEl) return;
  const screen = tabBarEl.closest('.draft-screen');
  tabBarEl.querySelectorAll('.mobile-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      tabBarEl.querySelectorAll('.mobile-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      screen.querySelectorAll('.tab-panel').forEach(p => {
        p.classList.toggle('tab-active', p.dataset.tab === btn.dataset.tab);
      });
    });
  });
}
setupTabs(document.getElementById('snakeTabs'));


