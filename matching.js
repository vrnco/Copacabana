// ============================================================
// Algoritmo de sorteio de duplas sem repetição (com fallback)
// ============================================================
//
// Recebe a lista de jogadores selecionados (IDs, quantidade PAR)
// e o histórico de duplas já formadas no circuito/categoria atual
// (apenas rodadas aprovadas).
//
// Regras de prioridade:
//   1) Tenta montar todas as duplas SEM nenhuma repetição.
//   2) Se for impossível, usa o MENOR número possível de duplas
//      repetidas.
//   3) Entre as opções de repetição, prioriza reformar a dupla
//      que jogou junta há MAIS TEMPO (a repetição "mais antiga").
//   4) Sempre que há mais de uma solução igualmente boa, escolhe
//      aleatoriamente entre elas (para manter o "sorteio").
//
// history: Map<"idA|idB" (ids ordenados), { lastDate: 'YYYY-MM-DD', count: n }>
//
// Retorna:
//   {
//     pairs: [{ a, b, isRepeat, lastDate|null }, ...],
//     repeatsUsed: number,
//     possible: true
//   }
//   ou lança um erro se nem com repetição for possível (nº ímpar, etc.)
// ============================================================

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// Embaralha um array (Fisher-Yates) usando um RNG injetável (facilita testes)
function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * @param {string[]} playerIds - IDs dos jogadores selecionados (tamanho par)
 * @param {Map<string, {lastDate: string, count: number}>} history
 * @param {Object} opts
 * @param {number} opts.maxNodes - limite de segurança de nós explorados na busca
 * @param {function} opts.rng - gerador de números aleatórios (0..1), injetável para testes
 */
function sortearDuplas(playerIds, history, opts = {}) {
  const maxNodes = opts.maxNodes || 400000;
  const timeLimitMs = opts.timeLimitMs || 4000;
  const rng = opts.rng || Math.random;
  const startTime = Date.now();

  if (playerIds.length % 2 !== 0) {
    throw new Error('Número de jogadores precisa ser par para sortear duplas.');
  }
  if (playerIds.length < 2) {
    return { pairs: [], repeatsUsed: 0, possible: true };
  }

  const ids = playerIds.slice();

  function historyOf(a, b) {
    return history.get(pairKey(a, b)) || null;
  }

  // custo textual/numérico usado só para ordenar candidatos (não é a
  // função objetivo formal - a otimização real é feita comparando
  // soluções completas, veja compareSolutions)
  function lastDateValue(a, b) {
    const h = historyOf(a, b);
    if (!h) return null;
    return new Date(h.lastDate + 'T00:00:00').getTime();
  }

  let nodesExplored = 0;
  let best = null; // { repeatEdges: [{a,b,lastDateVal}], matching: [[a,b],...] }

  function scoreOf(repeatEdges) {
    // primário: menos repetições. secundário: evitar a repetição mais
    // recente possível (maximizar a idade mínima). terciário: soma das idades.
    const count = repeatEdges.length;
    if (count === 0) return { count: 0, maxRecency: -Infinity, sumRecency: 0 };
    const dates = repeatEdges.map((e) => e.lastDateVal);
    const maxRecency = Math.max(...dates); // quanto MENOR melhor (mais antiga)
    const sumRecency = dates.reduce((s, d) => s + d, 0);
    return { count, maxRecency, sumRecency };
  }

  function isBetter(a, b) {
    // a e b são scores; retorna true se "a" é melhor que "b"
    if (a.count !== b.count) return a.count < b.count;
    if (a.maxRecency !== b.maxRecency) return a.maxRecency < b.maxRecency;
    return a.sumRecency < b.sumRecency;
  }

  let capped = false;

  function limitReached() {
    if (nodesExplored > maxNodes) return true;
    // Checar o relógio custa caro se feito a cada nó; checa a cada 500.
    if (nodesExplored % 500 === 0 && Date.now() - startTime > timeLimitMs) return true;
    return false;
  }

  function backtrack(remaining, repeatEdgesSoFar, matchingSoFar) {
    nodesExplored++;
    if (limitReached()) {
      capped = true;
      return; // limite de segurança (nós ou tempo) - usa a melhor solução já encontrada
    }

    // poda (branch and bound): como count/maxRecency/sumRecency só podem
    // crescer (ou ficar iguais) conforme mais duplas repetidas são
    // adicionadas, o score parcial é um limite inferior válido do score
    // final desta ramificação. Se o parcial já não é estritamente melhor
    // que a melhor solução completa encontrada até agora, essa ramificação
    // nunca vai produzir algo melhor - corta aqui (evita explorar
    // exaustivamente soluções empatadas, que não trazem benefício, já que
    // a aleatoriedade do sorteio já vem da ordem embaralhada da busca).
    if (best) {
      const partialScore = scoreOf(repeatEdgesSoFar);
      if (!isBetter(partialScore, best.score)) return;
    }

    if (remaining.length === 0) {
      const score = scoreOf(repeatEdgesSoFar);
      if (!best || isBetter(score, best.score)) {
        best = {
          score,
          matching: matchingSoFar.slice(),
          repeatEdges: repeatEdgesSoFar.slice(),
        };
      }
      return;
    }

    // fixa sempre o primeiro jogador da lista restante (reduz simetria)
    const [p, ...rest] = remaining;

    // candidatos: embaralha, mas processa primeiro os "frescos" (sem
    // histórico) antes dos repetidos, e entre os repetidos prioriza o
    // mais antigo primeiro - isso acelera achar boas soluções cedo,
    // o que fortalece a poda.
    const withInfo = rest.map((q) => {
      const h = historyOf(p, q);
      return { q, isRepeat: !!h, lastDateVal: h ? lastDateValue(p, q) : null };
    });

    const fresh = shuffle(
      withInfo.filter((x) => !x.isRepeat),
      rng
    );
    const repeated = withInfo
      .filter((x) => x.isRepeat)
      .sort((x, y) => x.lastDateVal - y.lastDateVal); // mais antiga primeiro

    const candidates = [...fresh, ...repeated];

    for (const c of candidates) {
      const newRemaining = rest.filter((x) => x !== c.q);
      matchingSoFar.push([p, c.q]);
      if (c.isRepeat) repeatEdgesSoFar.push({ a: p, b: c.q, lastDateVal: c.lastDateVal });

      backtrack(newRemaining, repeatEdgesSoFar, matchingSoFar);

      matchingSoFar.pop();
      if (c.isRepeat) repeatEdgesSoFar.pop();

      if (capped) return;
    }
  }

  backtrack(shuffle(ids, rng), [], []);

  if (!best) {
    throw new Error('Não foi possível sortear duplas com esses jogadores.');
  }

  const pairs = best.matching.map(([a, b]) => {
    const h = historyOf(a, b);
    return {
      a,
      b,
      isRepeat: !!h,
      lastDate: h ? h.lastDate : null,
    };
  });

  return {
    pairs,
    repeatsUsed: best.repeatEdges.length,
    capped, // true = atingiu o limite de segurança; resultado é válido mas pode não ser o ótimo absoluto

    possible: true,
    nodesExplored,
  };
}

// Constrói o mapa de histórico a partir das linhas retornadas do Supabase
// (join de pairs + rounds), já filtrado por circuito/categoria/aprovado.
function buildHistoryMap(pairRows) {
  const history = new Map();
  for (const row of pairRows) {
    const key = pairKey(row.player1_id, row.player2_id);
    const existing = history.get(key);
    if (!existing || row.round_date > existing.lastDate) {
      history.set(key, {
        lastDate: row.round_date,
        count: (existing ? existing.count : 0) + 1,
      });
    } else {
      existing.count += 1;
    }
  }
  return history;
}

export { sortearDuplas, buildHistoryMap, pairKey, shuffle };
