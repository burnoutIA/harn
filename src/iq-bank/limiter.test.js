
// Tests de l'épreuve « limiter » (banc d'intelligence, palier expert).
// Le code du modèle est au-dessus ; les `export` ont été retirés.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const check = async (name, fn) => {
    try { results.push(Boolean(await Promise.race([fn(), sleep(3000).then(() => false)]))); } catch { results.push(false); }
    console.log(`RESULTAT-@@JETON@@ ${results.filter(Boolean).length}/8`);
  };
  // Une tâche : attend `ms`, renvoie `value`, et tient le compte des tâches en cours.
  const pool = () => {
    const s = { running: 0, max: 0, started: 0 };
    s.task = (ms, value, fail = false) => async () => {
      s.started += 1; s.running += 1; s.max = Math.max(s.max, s.running);
      await sleep(ms);
      s.running -= 1;
      if (fail) throw new Error(value);
      return value;
    };
    return s;
  };

  await check('ordre des résultats', async () => {
    const s = pool();
    const out = await limiter([s.task(40, 'a'), s.task(5, 'b'), s.task(20, 'c')], 2);
    return JSON.stringify(out) === '["a","b","c"]';
  });
  await check('jamais plus de n à la fois, et bien n', async () => {
    const s = pool();
    await limiter(Array.from({ length: 9 }, (_, i) => s.task(10 + (i % 3) * 7, i)), 3);
    return s.max === 3 && s.started === 9;
  });
  await check('une place libérée est reprise aussitôt (pas de lots)', async () => {
    const s = pool();
    const t0 = Date.now();
    await limiter([s.task(150, 1), s.task(35, 2), s.task(35, 3), s.task(35, 4), s.task(35, 5)], 2);
    return Date.now() - t0 < 200;
  });
  await check('démarre n tâches tout de suite', async () => {
    const s = pool();
    const p = limiter([s.task(20, 1), s.task(20, 2), s.task(20, 3)], 2);
    await sleep(5);
    const ok = s.started === 2;
    await p;
    return ok;
  });
  await check('liste vide', async () => JSON.stringify(await limiter([], 4)) === '[]');
  await check('n plus grand que le nombre de tâches', async () => {
    const s = pool();
    return JSON.stringify(await limiter([s.task(5, 'x'), s.task(1, 'y')], 10)) === '["x","y"]';
  });
  await check('un échec rejette avec la même erreur', async () => {
    const s = pool();
    try { await limiter([s.task(5, 'a'), s.task(5, 'boom', true), s.task(5, 'c')], 2); return false; } catch (e) { return e instanceof Error && e.message === 'boom'; }
  });
  await check('après un échec, plus aucune tâche ne démarre', async () => {
    const s = pool();
    try { await limiter([s.task(10, 'a'), s.task(5, 'boom', true), s.task(5, 'c'), s.task(5, 'd')], 1); } catch {}
    await sleep(60);
    return s.started === 2;
  });
})();
