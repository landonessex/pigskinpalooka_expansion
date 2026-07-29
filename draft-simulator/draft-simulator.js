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

const TOTAL_ROUNDS = 17;
const NUM_TEAMS = 12;
const PICK_SECONDS = 60;
const AUCTION_BUDGET = 100;

function auctionValueOf(p){
  return AUCTION_VALUES[p.name] ?? 0.05;
}

// ===================================================================
// Global state
// ===================================================================
const state = {
  userTeam: null,
  draftType: 'snake',
  orderMode: 'random',
  order: [],          // array of team names, draft order
  teams: {},          // name -> { name, isExpansion, baseline: [...], drafted: [...], budget, totalValue }
  pool: [],           // mutable remaining pool
  // snake-specific
  round: 1,
  pickWithinRound: 0,
  pickNo: 0,
  timerInterval: null,
  timeLeft: PICK_SECONDS,
  // auction-specific
  nominationTurnIdx: 0,
  auctionPhase: 'nominate', // 'nominate' | 'bid'
  currentNominee: null,
  currentNominator: null,
  liveAuction: null, // { player, currentPrice, currentLeader, aiCeilings }
  // filters
  snakeFilter: 'ALL', snakeSearch: '',
  auctionFilter: 'ALL', auctionSearch: '',
};

// ===================================================================
// Setup screen
// ===================================================================
const teamSelect = document.getElementById('teamSelect');
const orderGroup = document.getElementById('orderGroup');
const typeGroup = document.getElementById('typeGroup');
const startBtn = document.getElementById('startBtn');
const setupNote = document.getElementById('setupNote');

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
wireRadioGroup(typeGroup, v => state.draftType = v);

setupNote.textContent = `Pool for this draft: ${POOL17.length} players left over after all 12 teams keep their 12. ${NUM_TEAMS} teams \u00d7 ${TOTAL_ROUNDS} rounds = ${NUM_TEAMS*TOTAL_ROUNDS} slots \u2014 since that's more than the pool holds, the draft ends early once the pool runs dry rather than forcing a full ${TOTAL_ROUNDS} rounds for everyone.`;

startBtn.addEventListener('click', () => {
  state.userTeam = teamSelect.value;
  initializeDraft();
});

// ===================================================================
// Initialization
// ===================================================================
function initializeDraft(){
  // Build per-team working state
  TEAMS12.forEach(t => {
    state.teams[t.name] = {
      name: t.name,
      isExpansion: t.isExpansion,
      baseline: t.roster,
      drafted: [],
      budget: AUCTION_BUDGET,
    };
  });

  // Draft order
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

  document.getElementById('setupScreen').classList.add('hidden');

  if (state.draftType === 'snake'){
    document.getElementById('snakeScreen').classList.add('active');
    startSnakeDraft();
  } else {
    document.getElementById('auctionScreen').classList.add('active');
    startAuctionDraft();
  }
}

function teamQbCount(team){
  return team.baseline.filter(isStarterQB).length + team.drafted.filter(isStarterQB).length;
}

function aiEffectiveValue(p, team, valuator){
  let v = valuator(p);
  if (isStarterQB(p) && teamQbCount(team) < QB_NEED_TARGET) v *= QB_NEED_BOOST;
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
// AUCTION DRAFT ENGINE
// Sealed-max-bid format: when a player is nominated, every eligible team
// (AI instantly, user via the bid box) submits a private max bid at once.
// Highest bid wins, paying $1 over the 2nd-highest bid (capped at their
// own max) — approximates a live ascending auction without needing a
// real-time bidding war UI.
// ===================================================================
function allTeamsFull(){
  return Object.values(state.teams).every(t => t.drafted.length >= TOTAL_ROUNDS);
}

function countTotalDrafted(){
  return Object.values(state.teams).reduce((s,t) => s + t.drafted.length, 0);
}

function maxAffordable(team){
  const slotsAfter = TOTAL_ROUNDS - team.drafted.length - 1; // slots still needed after winning this one
  return team.budget - Math.max(0, slotsAfter);
}

function desiredBid(p, team){
  let v = auctionValueOf(p);
  if (isStarterQB(p) && teamQbCount(team) < QB_NEED_TARGET) v *= 1.4;
  v *= (0.85 + Math.random() * 0.3);
  return v;
}

function computeAiBid(p, team){
  if (team.drafted.length >= TOTAL_ROUNDS) return 0;
  const cap = maxAffordable(team);
  if (cap < 1) return 0;
  return Math.max(0, Math.min(cap, desiredBid(p, team)));
}

// Fixed per-player AI ceilings (their true max willingness to pay), computed
// once when a player is nominated. The live auction never reveals these —
// AI teams only ever raise the minimum needed to retake the lead, exactly
// like real proxy bidding.
function computeAiCeilings(player){
  const ceilings = {};
  Object.values(state.teams).forEach(team => {
    if (team.name === state.userTeam) return;
    ceilings[team.name] = computeAiBid(player, team);
  });
  return ceilings;
}

// Full equilibrium among AI teams alone (used right after nomination, since
// several AI could compete with each other before the user even acts).
function resolveFullAiCompetition(ceilings){
  const entries = Object.entries(ceilings).filter(([,ceil]) => ceil >= 1);
  if (entries.length === 0) return null;
  entries.sort((a,b) => b[1] - a[1]);
  const [winnerName, winnerCeil] = entries[0];
  const secondCeil = entries[1] ? entries[1][1] : 0;
  const price = Math.max(1, Math.min(winnerCeil, secondCeil + 1));
  return { name: winnerName, price };
}

// Does any AI (other than excludeName) want to beat minPrice? If several do,
// resolve their own mini-equilibrium too so only one clean raise is shown.
function bestAiChallenge(ceilings, minPrice, excludeName){
  const entries = Object.entries(ceilings).filter(([name,ceil]) => name !== excludeName && ceil > minPrice);
  if (entries.length === 0) return null;
  entries.sort((a,b) => b[1] - a[1]);
  const [name, ceil] = entries[0];
  const second = entries[1] ? entries[1][1] : minPrice;
  const price = Math.max(minPrice + 1, Math.min(ceil, second + 1));
  return { name, price };
}

function removeFromPool(player){
  const idx = state.pool.findIndex(p => p.name === player.name);
  if (idx !== -1) state.pool.splice(idx, 1);
}

function logAuction(msg, isUser){
  const log = document.getElementById('auctionLog');
  const li = document.createElement('li');
  if (isUser) li.className = 'you';
  li.innerHTML = msg;
  log.insertBefore(li, log.firstChild);
}

function awardPlayer(teamName, player, price){
  const team = state.teams[teamName];
  team.budget -= price;
  team.drafted.push({...player, pricePaid: price});
  removeFromPool(player);
  const isYou = teamName === state.userTeam;
  const line = `<strong>${player.name}</strong> to ${teamName}${isYou?' (you)':''} for $${price}`;
  logAuction(line, isYou);
  const banner = document.getElementById('auctionLastPick');
  banner.classList.toggle('you', isYou);
  banner.querySelector('.lp-content').innerHTML = line;
  renderBudgets();
  if (teamName === state.userTeam) renderAuctionYourRoster();
}

function finalizeLiveAuction(){
  clearInterval(state.timerInterval);
  document.getElementById('nominationArea').innerHTML = '';
  document.getElementById('auctionTimer').classList.add('hidden');
  const { player, currentPrice, currentLeader } = state.liveAuction;
  awardPlayer(currentLeader, player, currentPrice);
  state.liveAuction = null;
  state.auctionPhase = 'nominate';
  state.nominationTurnIdx++;
  runNominationTurn();
}

function renderLiveBidUI(){
  const { player, currentPrice, currentLeader } = state.liveAuction;
  const area = document.getElementById('nominationArea');
  renderAuctionPool();

  if (currentLeader === state.userTeam){
    // Nobody's contesting the user right now — nothing left to decide.
    area.innerHTML = `<div class="bid-box"><h3>You're leading on ${player.name} at $${currentPrice}</h3><p style="color:var(--text-dim);font-size:13px;">No one else wants it at this price \u2014 wrapping up.</p></div>`;
    document.getElementById('auctionTimer').classList.add('hidden');
    setTimeout(finalizeLiveAuction, 700);
    return;
  }

  const team = state.teams[state.userTeam];
  const cap = Math.max(0, Math.floor(maxAffordable(team)));
  const minRaise = currentPrice + 1;
  const canRaise = cap >= minRaise;

  area.innerHTML = `
    <div class="bid-box">
      <h3>${player.name} <span class="ptag tag-${player.pos}">${player.pos}</span> \u2014 ${currentLeader} leads at $${currentPrice}</h3>
      <div class="value-ref">DLF auction value: $${Math.round(auctionValueOf(player))} &middot; your max affordable bid: $${cap}</div>
      <div class="bid-input-row">
        <input type="number" id="userBidInput" min="${minRaise}" max="${Math.max(minRaise,cap)}" step="1" placeholder="$${minRaise}+" ${canRaise?'':'disabled'}>
        <button class="bid-submit-btn" id="submitBidBtn" ${canRaise?'':'disabled'}>Raise</button>
        <button class="skip-btn" id="passBidBtn">Pass</button>
      </div>
      ${canRaise?'':'<p style="color:var(--text-faint);font-size:11px;margin-top:8px;">You can\'t afford to top this bid and still fill your remaining slots.</p>'}
    </div>
  `;
  if (canRaise){
    document.getElementById('submitBidBtn').addEventListener('click', () => {
      const val = parseInt(document.getElementById('userBidInput').value, 10);
      const raiseTo = (isNaN(val) || val < minRaise) ? minRaise : Math.min(val, cap);
      userRaise(raiseTo);
    });
  }
  document.getElementById('passBidBtn').addEventListener('click', finalizeLiveAuction);
}

function userRaise(amount){
  clearInterval(state.timerInterval);
  state.liveAuction.currentPrice = amount;
  state.liveAuction.currentLeader = state.userTeam;
  logAuction(`You raise to $${amount}`, true);
  const challenge = bestAiChallenge(state.liveAuction.aiCeilings, amount, state.userTeam);
  if (challenge){
    state.liveAuction.currentPrice = challenge.price;
    state.liveAuction.currentLeader = challenge.name;
    logAuction(`${challenge.name} comes back at $${challenge.price}`);
  }
  renderLiveBidUI();
  if (state.liveAuction.currentLeader !== state.userTeam){
    startAuctionTimer(finalizeLiveAuction);
  }
}

function beginBidding(nominatorName, player){
  clearInterval(state.timerInterval);
  state.auctionPhase = 'bid';
  state.currentNominee = player;
  state.currentNominator = nominatorName;

  const aiCeilings = computeAiCeilings(player);
  let currentPrice = 1;
  let currentLeader = nominatorName;
  const initial = resolveFullAiCompetition(aiCeilings);
  if (initial){
    currentPrice = initial.price;
    currentLeader = initial.name;
    if (currentLeader !== nominatorName){
      logAuction(`${nominatorName} opens at $1 \u2014 ${currentLeader} jumps in at $${currentPrice}`);
    }
  }
  state.liveAuction = { player, currentPrice, currentLeader, aiCeilings };

  const userTeamObj = state.teams[state.userTeam];
  const userEligible = userTeamObj.drafted.length < TOTAL_ROUNDS && maxAffordable(userTeamObj) >= 1;

  if (!userEligible){
    document.getElementById('nominationArea').innerHTML = `<div class="bid-box"><h3>${player.name} \u2014 ${currentLeader} at $${currentPrice}</h3><p style="color:var(--text-dim);">You're full or out of budget \u2014 sitting this one out.</p></div>`;
    document.getElementById('auctionTimer').classList.add('hidden');
    setTimeout(finalizeLiveAuction, 700);
    return;
  }

  renderLiveBidUI();
  if (currentLeader !== state.userTeam){
    startAuctionTimer(finalizeLiveAuction);
  }
}


function runNominationTurn(){
  if (state.pool.length === 0 || allTeamsFull()){ endAuctionDraft(); return; }
  let attempts = 0;
  while (state.teams[state.order[state.nominationTurnIdx % NUM_TEAMS]].drafted.length >= TOTAL_ROUNDS){
    state.nominationTurnIdx++;
    attempts++;
    if (attempts > NUM_TEAMS){ endAuctionDraft(); return; }
  }
  const teamName = state.order[state.nominationTurnIdx % NUM_TEAMS];
  state.currentNominator = teamName;
  state.auctionPhase = 'nominate';
  renderAuctionPool();
  renderBudgets();
  document.getElementById('auctionPickIndicator').textContent = `Nomination #${countTotalDrafted()+1}`;
  const onClockEl = document.getElementById('auctionOnClock');
  onClockEl.textContent = `Nominating: ${teamName}${teamName===state.userTeam?' (YOU)':''}`;
  onClockEl.className = 'on-clock' + (teamName === state.userTeam ? ' you' : '');

  if (teamName === state.userTeam){
    document.getElementById('nominationArea').innerHTML = `<div class="nomination-box"><h3>Your turn to nominate</h3><p style="color:var(--text-dim);font-size:13px;">Pick anyone from the pool below and click Nominate.</p></div>`;
    startAuctionTimer(() => {
      const team = state.teams[state.userTeam];
      const pick = aiBestPick(team, state.pool, auctionValueOf);
      if (pick) beginBidding(teamName, pick);
      else { state.nominationTurnIdx++; runNominationTurn(); }
    });
  } else {
    document.getElementById('auctionTimer').classList.add('hidden');
    document.getElementById('nominationArea').innerHTML = '';
    setTimeout(() => {
      const team = state.teams[teamName];
      const pick = aiBestPick(team, state.pool, auctionValueOf);
      if (pick) beginBidding(teamName, pick);
      else { state.nominationTurnIdx++; runNominationTurn(); }
    }, 500);
  }
}

function startAuctionTimer(onTimeout){
  const timerEl = document.getElementById('auctionTimer');
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
      onTimeout();
    }
  }, 1000);
}

function startAuctionDraft(){
  document.getElementById('auctionLog').innerHTML = '';
  state.nominationTurnIdx = 0;
  state.auctionPhase = 'nominate';
  renderBudgets();
  renderAuctionYourRoster();
  runNominationTurn();
}

function renderBudgets(){
  const grid = document.getElementById('budgetGrid');
  grid.innerHTML = '';
  state.order.forEach(name => {
    const t = state.teams[name];
    const div = document.createElement('div');
    div.className = 'budget-card' + (name === state.userTeam ? ' you' : '');
    div.innerHTML = `<div class="budget-name">${name}${name===state.userTeam?' (you)':''}</div><div class="budget-amt mono">$${t.budget}</div><div class="budget-slots mono">${t.drafted.length}/${TOTAL_ROUNDS} slots</div>`;
    grid.appendChild(div);
  });
  const you = state.teams[state.userTeam];
  document.getElementById('auctionYourStatusText').textContent = `$${you.budget} \u00b7 ${you.drafted.length}/${TOTAL_ROUNDS} slots`;
}

function renderAuctionYourRoster(){
  const team = state.teams[state.userTeam];
  const list = document.getElementById('auctionYourRoster');
  document.getElementById('auctionYourCount').textContent = `${team.drafted.length}/${TOTAL_ROUNDS} slots \u00b7 $${team.budget} left`;
  list.innerHTML = '';
  team.drafted.slice().reverse().forEach((p,i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="slotnum mono">${team.drafted.length-i}</span><span class="pname">${isStarterQB(p)?'<span class=\"qb-star\">\u2736</span>':''}${p.name}</span><span class="ptag tag-${p.pos}">${p.pos}</span><span class="pval mono">$${p.pricePaid}</span>`;
    list.appendChild(li);
  });
}

function renderAuctionPool(){
  const canNominate = state.auctionPhase === 'nominate' && state.currentNominator === state.userTeam;
  const body = document.getElementById('auctionPoolBody');
  let filtered = state.pool;
  if (state.auctionFilter !== 'ALL') filtered = filtered.filter(p => p.pos === state.auctionFilter);
  if (state.auctionSearch) filtered = filtered.filter(p => p.name.toLowerCase().includes(state.auctionSearch));
  filtered = filtered.slice().sort((a,b) => auctionValueOf(b) - auctionValueOf(a));
  document.getElementById('auctionPoolCount').textContent = `${filtered.length} shown / ${state.pool.length} left`;
  body.innerHTML = '';
  filtered.forEach(p => {
    const tr = document.createElement('tr');
    const star = isStarterQB(p) ? '<span class="qb-star" title="NFL starting QB">\u2736</span>' : '';
    tr.innerHTML = `
      <td>${p.name}</td>
      <td>${star}<span class="ptag tag-${p.pos}">${p.pos}</span></td>
      <td style="color:var(--text-faint);font-size:12px;">${p.team||'—'}</td>
      <td class="mono" style="text-align:right;color:var(--gold-dim);">$${Math.round(auctionValueOf(p))}</td>
      <td><button class="draft-btn" ${canNominate?'':'disabled'} data-name="${p.name}">Nominate</button></td>
    `;
    body.appendChild(tr);
  });
  body.querySelectorAll('.draft-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!(state.auctionPhase === 'nominate' && state.currentNominator === state.userTeam)) return;
      const player = state.pool.find(p => p.name === btn.dataset.name);
      if (!player) return;
      beginBidding(state.userTeam, player);
    });
  });
}

document.getElementById('auctionSearch').addEventListener('input', (e) => {
  state.auctionSearch = e.target.value.toLowerCase();
  renderAuctionPool();
});
document.querySelectorAll('#auctionScreen .pos-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#auctionScreen .pos-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.auctionFilter = btn.dataset.f;
    renderAuctionPool();
  });
});

function endAuctionDraft(){
  clearInterval(state.timerInterval);
  document.getElementById('auctionScreen').classList.remove('active');
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
      const priceTag = p.pricePaid != null ? `$${p.pricePaid}` : Math.round(p.value);
      html += `<li><span class="slotnum mono">${i+1}</span><span class="pname">${star}${p.name}</span><span class="ptag tag-${p.pos}">${p.pos}</span><span class="pval mono">${priceTag}</span></li>`;
    });
    html += '</ul></div></div>';
  });
  html += '</div>';

  summary.innerHTML = html;
}

// ===================================================================
// Mobile tab bar (Available / My Team / Log / Budgets)
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
setupTabs(document.getElementById('auctionTabs'));


