// ==UserScript==
// @name         Wiki Masters — aide mobile (achat et vente)
// @namespace    https://github.com/PDGTroisQuarts/Claude-code-repository/mobile
// @version      1.6.3
// @updateURL    https://raw.githubusercontent.com/PDGTroisQuarts/aide-mobile/main/wiki-masters-mobile.user.js
// @downloadURL  https://raw.githubusercontent.com/PDGTroisQuarts/aide-mobile/main/wiki-masters-mobile.user.js
// @description  Version téléphone de l'aide à la vente et à l'achat : valeur des cartes dans la collection, écart en % sur le marché, détail d'une carte et d'une enchère, télécommande du bot de surenchère. Ne mise ni ne vend jamais.
// @match        https://www.wiki-masters.com/*
// @match        https://wiki-masters.com/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      ntfy.sh
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Relais placé dans la page (téléphone : Firefox + Tampermonkey)
  // ---------------------------------------------------------------------------
  // Sous Firefox, le script tourne à part de la page (script d'extension) : il
  // ne peut pas envelopper lui-même le fetch de la page, et ses propres
  // requêtes ne partiraient pas tout à fait comme celles du site. Un petit
  // relais est donc placé dans la page. Il échange avec le script par des
  // événements du document, en texte seulement (seul format qui passe sans
  // souci d'un monde à l'autre) :
  //  - il signale chaque requête /api/ de la page, les erreurs, et le JSON des
  //    réponses /api/ et /rest/v1/ (comme l'aide à la vente de l'ordinateur) ;
  //  - il fait les requêtes du script avec le fetch d'origine de la page :
  //    mêmes cookies, même origine que le site.
  // Si la page refuse ce relais (politique de sécurité), rien n'est cassé : les
  // requêtes partent directement, et une carte inconnue se reconnaît par
  // l'onglet « Marché » de sa fiche.
  const CHANNEL = `wvp${Math.random().toString(36).slice(2, 10)}`;
  function pageBridge(ch) {
    const send = (m) => document.dispatchEvent(new CustomEvent(`${ch}-out`, { detail: JSON.stringify(m) }));
    const original = window.fetch;
    if (typeof original !== 'function') return;
    window.fetch = function (...args) {
      let asked = '';
      try {
        const raw = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || String(args[0] || '');
        const abs = new URL(raw, location.href);
        if (abs.origin === location.origin && abs.pathname.startsWith('/api/')) {
          asked = abs.href;
          send({ k: 'req', u: asked });
        }
      } catch (err) {
        // adresse illisible : non signalée
      }
      const promise = original.apply(this, args);
      promise.then((res) => {
        try {
          const url = String(res.url || asked);
          if (asked && res.status >= 400) send({ k: 'status', s: res.status, u: asked });
          if (!/\/(api|rest\/v1)\//.test(url) || !/json/i.test(res.headers.get('content-type') || '')) return;
          res.clone().text().then((t) => send({ k: 'json', u: url, t })).catch(() => {});
        } catch (err) {
          // réponse illisible : ignorée
        }
      }, () => {});
      return promise;
    };
    document.addEventListener(`${ch}-in`, (e) => {
      let m;
      try {
        m = JSON.parse(e.detail);
      } catch (err) {
        return;
      }
      original.call(window, m.url, { credentials: 'include', headers: m.accept ? { accept: 'application/json' } : {} })
        .then((res) => res.text().then((t) => send({ k: 'res', id: m.id, s: res.status, ra: res.headers.get('retry-after'), d: res.headers.get('date'), t })))
        .catch((err) => send({ k: 'res', id: m.id, err: String((err && err.message) || err) }));
    });
    send({ k: 'ready' });
  }

  const early = [];
  let skipUrl = () => false; // remplacé au démarrage : lectures faites par le script lui-même
  let onPageJson = (url, json) => early.length < 50 && early.push([url, json]);
  // Requêtes /api/ de la page (comptées par le portier de débit, plus bas) et
  // réponses en erreur (un refus du site, même pour la page, fait ralentir).
  const earlyRequests = [];
  let onPageRequest = (url) => earlyRequests.length < 200 && earlyRequests.push([url, Date.now()]);
  let onPageStatus = () => {};
  let hookedResponses = 0;
  let bridgeReady = false;
  const pendingCalls = new Map();
  let callSeq = 0;
  document.addEventListener(`${CHANNEL}-out`, (e) => {
    let m;
    try {
      m = JSON.parse(e.detail);
    } catch (err) {
      return;
    }
    if (m.k === 'ready') bridgeReady = true;
    else if (m.k === 'req') onPageRequest(m.u);
    else if (m.k === 'status') onPageStatus(m.s, m.u);
    else if (m.k === 'json') {
      if (skipUrl(m.u)) return;
      let json;
      try {
        json = JSON.parse(m.t);
      } catch (err) {
        return;
      }
      hookedResponses++;
      onPageJson(m.u, json);
    } else if (m.k === 'res') {
      const done = pendingCalls.get(m.id);
      if (done) {
        pendingCalls.delete(m.id);
        done(m);
      }
    }
  });
  // Placé dès que la page a une balise où l'accrocher : tout au début du
  // chargement, il n'y en a parfois pas encore ; on attend alors son apparition
  // (toujours avant le premier script du site).
  function injectBridge() {
    const parent = document.head || document.documentElement;
    if (!parent) return false;
    try {
      const tag = document.createElement('script');
      tag.textContent = `(${pageBridge})(${JSON.stringify(CHANNEL)});`;
      parent.appendChild(tag);
      tag.remove();
    } catch (err) {
      console.log('[WV] Relais dans la page impossible', err);
    }
    return true;
  }
  if (!injectBridge()) {
    const watcher = new MutationObserver(() => {
      if (injectBridge()) watcher.disconnect();
    });
    watcher.observe(document, { childList: true, subtree: true });
  }

  // Requête au site par le relais de la page (repli : fetch direct du script).
  // Réponse au format de fetch, réduite à ce que le script utilise.
  function pageFetch(url, accept = true) {
    const abs = new URL(url, location.href).href;
    if (!bridgeReady) {
      // Délai maximal, comme par le relais (30 s).
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 30000);
      return fetch(abs, { credentials: 'include', headers: accept ? { accept: 'application/json' } : {}, signal: ctrl.signal });
    }
    return new Promise((resolve, reject) => {
      const id = ++callSeq;
      const timeout = setTimeout(() => {
        pendingCalls.delete(id);
        reject(new Error('pas de réponse en 30 s'));
      }, 30000);
      pendingCalls.set(id, (m) => {
        clearTimeout(timeout);
        if (m.err) {
          reject(new Error(m.err));
          return;
        }
        resolve({
          ok: m.s >= 200 && m.s < 300,
          status: m.s,
          headers: { get: (name) => (/^retry-after$/i.test(name) ? m.ra : /^date$/i.test(name) ? m.d : null) },
          json: async () => JSON.parse(m.t),
          text: async () => m.t,
        });
      });
      document.dispatchEvent(new CustomEvent(`${CHANNEL}-in`, { detail: JSON.stringify({ id, url: abs, accept }) }));
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main, { once: true });
  else main();

  function main() {

  // ---------------------------------------------------------------------------
  // Réglages
  // ---------------------------------------------------------------------------

  const CONFIG = {
    // Durées proposées par le site, en minutes. v0.19.0 : toutes peuvent être
    // conseillées, quelle que soit la rareté (avant : ni 10 ni 30 min, ni 1 h
    // pour une légendaire).
    durations: [10, 30, 60, 180, 360, 720],
    // Si la carte n'a pas pu être repérée sans clic (mémoire, requêtes de la
    // page), ouvrir l'onglet « Marché » une fois, puis revenir sur « Détails ».
    // Réglable depuis le menu Tampermonkey.
    autoOpenMarket: true,
    // Attente avant ce dernier recours : aucune, pour avoir le conseil au plus vite.
    autoOpenDelayMs: 0,
    // Prix « Ambitieux » : chaque mise en vente ratée (carte à remettre en
    // vente) est comptée comme une perte de (1 − relistKeep) du prix.
    relistKeep: 0.85,
    // Les ventes de plus de 30 jours ne servent plus au profil horaire.
    keepSalesDays: 30,
    // Base horaire commune à toutes les cartes évaluées. Une heure avec peu de
    // ventes est rapprochée du profil par défaut (poids, en ventes pondérées).
    profilePriorWeight: 8,
    // Durée de chaque prix conseillé : la plus courte dont le prix estimé (selon
    // l'heure de fin) est à moins de minLongerGain wikibidous du meilleur.
    // « Lancer plus tard » : proposé seulement pour un gain d'au moins autant.
    minLongerGain: 100,
    // Heures conseillées calées sur la courbe de référence (le graphique du
    // profil par défaut) plutôt que sur la base mesurée (v0.19.0, demande de
    // l'utilisateur). La base mesurée reste affichée dans le diagnostic.
    useMeasuredProfile: false,
    // « Se vend beaucoup » (🔥) : au moins hotSales48h ventes (même carte, même
    // rareté) sur les 48 dernières heures.
    hotSales48h: 10,
    // « Se vend peu » (💤), quel que soit le prix : moins de thinSales7d ventes
    // (même carte, même rareté) sur 7 jours, ou plus de thinSpanDays jours entre
    // sa dernière vente et sa 10e dernière (ou moins de 10 ventes en tout).
    thinSales7d: 5,
    thinSpanDays: 7,
    // Carte « sans valeur » (défausse proposée, nettoyage, pastille rouge) :
    // pas de prix estimé (« – »), prix « Normal » sous worthlessBelow, ou 💤 et
    // prix sous thinWorthlessBelow.
    worthlessBelow: 30,
    thinWorthlessBelow: 50,
    // « Lancer plus tard » n'est proposé que pour un départ entre ces heures (Paris).
    wakeFromHour: 8,
    wakeToHour: 23,
    // Mémoire : titres → identifiant (30 000) et résumés de cartes (20 000),
    // quelques Mo en tout ; les plus anciens sont effacés d'abord.
    maxIds: 30000,
    maxSummaries: 20000,
    // Pastilles de la collection : prix « Normal » estimé. Rouge = sans valeur
    // (voir worthlessBelow), puis du bleu (worthlessBelow) au vert franc (valueGreen).
    valueGreen: 100,
    collectionSummaryHours: 48,
    // Cartes shiny : prime mesurée par rareté dès minCards cartes (sinon toutes
    // raretés confondues) ; une carte shiny est estimée sur ses propres ventes
    // shiny dès ownMinSales ventes, sinon valeur normale × (1 + prime).
    shiny: {
      minCards: 8,
      ownMinSales: 5,
      baselineDays: 15,
    },
    // Aide à l'achat (pastilles sur /marketplace).
    buy: {
      // Plafonds seulement à partir de ce nombre de ventes.
      minSales: 8,
      // « À garder » : attendre une autre occasion coûte 5 % de la médiane.
      waitCost: 0.05,
      // « À revendre » : marge visée sur la valeur de revente (25 % = plafond à 80 %).
      resaleMargin: 0.25,
      // Pas minimal d'une surenchère, relevé sur les notifications (+10 %).
      bidStep: 0.1,
      // Lecture des ventes pour les pastilles : 3 lectures simultanées au plus,
      // au rythme permis par le portier de débit (aucun refus du site) ;
      // historique gardé 10 min en mémoire. Relevé réel (v0.9.3) : à 16 à la
      // fois, le site répondait en 5,1 s et refusait (403) 60 lectures pour 50.
      parallel: 3,
      cacheMinutes: 10,
      // Résumé par carte (médiane, prix estimé, plafonds) : affiché aussitôt
      // pour une carte déjà vue, puis relu s'il a plus de 6 h.
      summaryHours: 6,
      // Couleur des pastilles : vert franc à −80 % de la médiane, jaune à 0,
      // rouge franc à +80 %.
      colorSpan: 0.8,
    },
    debug: true,
  };

  const RARITIES = ['C', 'PC', 'R', 'SR', 'UR', 'L'];
  const KEY_SALES = 'wv.sales';
  const KEY_MINIMIZED = 'wv.minimized';
  const KEY_TOP = 'wv.panelTop';
  const KEY_IDS = 'wv.ids';
  const KEY_AUTO_OPEN = 'wv.autoOpenMarket';
  const KEY_COLLECTION = 'wv.collection';
  const KEY_SUMMARY = 'wv.summary';
  const KEY_DELTA_REF = 'wv.deltaRef';
  // Référence du « 0 % » des pastilles du marché et de l'encart d'une enchère.
  const DELTA_REFS = { quick: 'vente rapide', resaleCap: 'mise max pour revendre', normal: 'vente normale' };
  const deltaRef = () => {
    const r = GM_getValue(KEY_DELTA_REF, 'quick');
    return DELTA_REFS[r] ? r : 'quick';
  };
  // Prix de référence d'une carte, et son nom (repli si la référence manque).
  function refOf(v) {
    const want = deltaRef();
    for (const k of [want, 'quick', 'normal']) if (v[k] != null) return { price: v[k], name: DELTA_REFS[k] };
    return { price: v.median, name: 'médiane' };
  }
  let collectionMem = GM_getValue(KEY_COLLECTION, {});
  const DAY = 864e5;
  const log = (...args) => CONFIG.debug && console.log('[WV]', ...args);
  // Pas de nettoyage sur le téléphone (lu par les minuteries communes au script d'ordinateur).
  const clean = { running: false };

  // ---------------------------------------------------------------------------
  // Statistiques
  // ---------------------------------------------------------------------------

  const byNumber = (a, b) => a - b;
  function quantile(sorted, q) {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  // Horodatage d'une vente, lu une seule fois : un historique compte jusqu'à
  // quelques milliers de ventes, reprises à chaque calcul.
  const tsOf = (s) => s._t ?? (s._t = Date.parse(s.settled_at));
  // Nombre de prix ≥ p dans une liste triée (recherche dichotomique).
  function countAtLeast(sorted, p) {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < p) lo = mid + 1;
      else hi = mid;
    }
    return sorted.length - lo;
  }

  // Ventes shiny : l'historique des ventes du site ne le dit pas (relevé du
  // 25/09 : identifiant, prix, date, rareté). Une vente est comptée shiny si
  // elle le dit elle-même (is_shiny, si le site l'ajoute), ou si son
  // identifiant est celui d'une enchère shiny vue sur le marché (même
  // identifiant pour l'enchère et la vente : contrôlé, voir le diagnostic).
  // Les ventes shiny connues sont écartées des prix d'une carte normale.
  let shinyAuctions = {};
  const isShinySale = (s) => s.is_shiny === true || s.shiny === true || !!shinyAuctions[s.id];

  // Ventes utilisées : même rareté (et même version, normale ou shiny), 7
  // derniers jours ; à défaut les 10 dernières. Les prix aberrants (plus de 3
  // fois la médiane, ou moins du tiers) sont écartés.
  function salesPool(sales, rarity, now, shiny = false) {
    const same = sales
      .filter((s) => (!rarity || s.rarity === rarity) && isShinySale(s) === shiny)
      .sort((a, b) => tsOf(b) - tsOf(a));
    let pool = same.filter((s) => now - tsOf(s) <= 7 * DAY);
    let period = '7 derniers jours';
    if (pool.length < 5) {
      pool = same.slice(0, 10);
      period = `${pool.length} dernières ventes`;
    }
    let prices = pool.map((s) => s.final_price).sort(byNumber);
    const rawMedian = prices.length ? quantile(prices, 0.5) : 0;
    const dropped = prices.length >= 5 ? prices.filter((p) => p > 3 * rawMedian || p < rawMedian / 3) : [];
    if (dropped.length) prices = prices.filter((p) => !dropped.includes(p));
    return { same, pool, period, dropped, prices };
  }

  // Nombre de ventes de la même rareté sur les 7 derniers jours (liquidité).
  const sales7d = (sales, rarity, now, shiny = false) => sales
    .filter((s) => (!rarity || s.rarity === rarity) && now - tsOf(s) <= 7 * DAY && isShinySale(s) === shiny).length;
  // Même chose sur 48 h : 🔥 « se vend beaucoup » dès hotSales48h ventes.
  const sales48h = (sales, rarity, now, shiny = false) => sales
    .filter((s) => (!rarity || s.rarity === rarity) && now - tsOf(s) <= 2 * DAY && isShinySale(s) === shiny).length;
  const isHot = (sales48) => sales48 != null && sales48 >= CONFIG.hotSales48h;
  // Carte peu vendue et peu chère : ne vaut pas une place sur le marché.
  // Jours entre la dernière vente et la 10e dernière (même rareté, même
  // version) ; null s'il y en a moins de 10.
  function span10d(sales, rarity, shiny = false) {
    const t = sales.filter((s) => (!rarity || s.rarity === rarity) && isShinySale(s) === shiny).map(tsOf).sort((a, b) => b - a);
    return t.length >= 10 ? Math.round(((t[0] - t[9]) / DAY) * 10) / 10 : null;
  }
  // 💤 « se vend peu », quel que soit le prix. span10 : undefined = pas encore
  // mesuré (résumé d'avant la v0.14), null = moins de 10 ventes.
  const isThin = (sales7, span10) => (sales7 != null && sales7 < CONFIG.thinSales7d)
    || (span10 !== undefined && (span10 === null || span10 > CONFIG.thinSpanDays));
  // Sans valeur : à défausser (fiche, nettoyage), pastille rouge.
  const worthless = (normal, thin) => normal === null || normal < CONFIG.worthlessBelow || (thin && normal < CONFIG.thinWorthlessBelow);
  // Explication du 💤 (encarts, infobulles).
  const thinText = (sales7, span10) => `${sales7 ?? '?'} vente${sales7 > 1 ? 's' : ''} en 7 jours`
    + (span10 === null ? ', moins de 10 ventes en tout' : span10 !== undefined ? `, 10 dernières ventes sur ${String(span10).replace('.', ',')} jours` : '');

  function priceAdvice(sales, rarity, now, shiny = false, poolData = salesPool(sales, rarity, now, shiny)) {
    const { same, pool, period, dropped, prices } = poolData;
    if (pool.length < 3) return { enough: false, n: pool.length, total: same.length };

    const n = prices.length;
    const share = (p) => countAtLeast(prices, p) / n;
    const p25 = quantile(prices, 0.25);
    const median = quantile(prices, 0.5);
    const p70 = quantile(prices, 0.7);

    // « Normal » : le prix qui maximise prix × part des ventes ≥ prix, borné
    // entre la médiane et P70 ; la médiane seule si les ventes sont trop peu nombreuses.
    let best = median;
    if (n >= 8) {
      let bestScore = -1;
      for (const p of new Set(prices)) {
        const score = p * share(p);
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
      best = Math.min(Math.max(best, median), p70);
    }
    // « Ambitieux » : la carte peut être remise en vente si elle ne part pas.
    // Valeur d'une mise en vente à p, en comptant les remises en vente :
    //   V(p) = p × S / (1 − k × (1 − S)), S = part des ventes ≥ p, k = relistKeep.
    // On garde le p qui maximise V, borné entre P60 et P75 (25 à 40 % des
    // ventes l'ont atteint) ; seulement à partir de 8 ventes.
    let ambitiousRaw = null;
    if (n >= 8) {
      ambitiousRaw = resaleValue(prices).price;
      ambitiousRaw = Math.min(Math.max(ambitiousRaw, quantile(prices, 0.6)), quantile(prices, 0.75));
    }
    // Prix exacts, sans arrondi : un prix précis est plus vendeur.
    const quick = Math.max(1, Math.round(p25));
    const normal = Math.max(quick, Math.round(best));
    const ambitious = ambitiousRaw === null ? null : Math.max(normal + 1, Math.round(ambitiousRaw));
    return {
      enough: true,
      n,
      period,
      dropped,
      min: prices[0],
      median,
      max: prices[n - 1],
      last: pool[0],
      quick,
      quickShare: share(quick),
      normal,
      normalShare: share(normal),
      ambitious,
      ambitiousShare: ambitious === null ? null : share(ambitious),
      confidence: n < 8 ? 'faible' : n < 20 ? 'moyenne' : 'bonne',
    };
  }

  // Valeur de revente d'une carte (prix triés) : ce que rapporte en moyenne une
  // mise en vente au meilleur prix p, remises en vente comprises :
  //   V(p) = p × S / (1 − k × (1 − S)), S = part des ventes ≥ p, k = relistKeep.
  function resaleValue(prices) {
    const n = prices.length;
    const k = CONFIG.relistKeep;
    let best = { value: -1, price: null };
    for (const p of new Set(prices)) {
      const sh = countAtLeast(prices, p) / n;
      const value = (p * sh) / (1 - k * (1 - sh));
      if (value > best.value) best = { value, price: p };
    }
    return best;
  }

  // Prix de réserve de la recherche séquentielle (McCall, 1970) : acheter
  // maintenant dès que le prix est ≤ r, où r vérifie E[(r − P)⁺] = c. c est le
  // coût d'attendre une autre occasion ; P suit la loi des ventes récentes.
  function reservationPrice(prices, c) {
    const gain = (r) => prices.reduce((sum, p) => sum + Math.max(0, r - p), 0) / prices.length;
    let lo = 0;
    let hi = prices[prices.length - 1] + c;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (gain(mid) < c) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  // Aide à l'achat : où se place un prix parmi les ventes récentes, et les deux
  // plafonds (carte à garder, carte à revendre). Plafonds à partir de minSales ventes.
  function buyAdvice(sales, rarity, now, shiny = false, poolData = salesPool(sales, rarity, now, shiny)) {
    const { pool, period, prices } = poolData;
    const n = prices.length;
    if (pool.length < 3 || !n) return { enough: false, n };
    const median = quantile(prices, 0.5);
    const advice = { enough: true, n, period, median, min: prices[0], max: prices[n - 1], keepCap: null, resaleCap: null, resale: null };
    if (n >= CONFIG.buy.minSales) {
      advice.keepCap = Math.floor(reservationPrice(prices, CONFIG.buy.waitCost * median));
      advice.resale = resaleValue(prices).value;
      advice.resaleCap = Math.floor(advice.resale / (1 + CONFIG.buy.resaleMargin));
    }
    // Rang centile d'un prix : part des ventes moins chères (ex æquo pour moitié).
    advice.percentile = (price) => {
      const below = n - countAtLeast(prices, price);
      const equal = countAtLeast(prices, price) - countAtLeast(prices, price + 1e-9);
      return (below + equal / 2) / n;
    };
    return advice;
  }

  // Conseils de vente et d'achat d'une carte, calculés une fois par minute
  // (l'encart est redessiné bien plus souvent).
  const adviceMemo = new WeakMap();
  function adviceFor(sales, rarity, shiny = false) {
    const now = Date.now();
    let byKey = adviceMemo.get(sales);
    if (!byKey) adviceMemo.set(sales, (byKey = new Map()));
    const key = `${rarity}|${shiny}`;
    const hit = byKey.get(key);
    if (hit && now - hit.at < 60000) return hit;
    const pool = salesPool(sales, rarity, now, shiny);
    const out = { at: now, price: priceAdvice(sales, rarity, now, shiny, pool), buy: buyAdvice(sales, rarity, now, shiny, pool), sales7: sales7d(sales, rarity, now, shiny),
      sales48: sales48h(sales, rarity, now, shiny), span10: span10d(sales, rarity, shiny) };
    byKey.set(key, out);
    return out;
  }

  // Heure et type de jour à Paris (le site vise des joueurs français).
  const parisFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const parisHour = (ts) => Number(parisFmt.formatToParts(new Date(ts)).find((p) => p.type === 'hour').value);

  // Profil par défaut, pour les heures sans données (écart de prix en log,
  // heure de Paris, de 0 h à 23 h) : nuit défavorable, soirée favorable.
  const DEFAULT_HOURLY = [0, -0.03, -0.06, -0.08, -0.08, -0.08, -0.07, -0.05, -0.03, -0.02, -0.01, 0,
    0.01, 0.01, 0, 0, 0, 0.01, 0.02, 0.04, 0.05, 0.05, 0.05, 0.03];
  // Courbe de référence : ce profil lissé sur ±2 h et recentré (graphique
  // « prix selon l'heure de fin »). Elle ordonne les heures : 21 h > 11 h,
  // 8 h > 4 h, 19 h > 23 h…
  const GRAPH_HOURLY = (() => {
    const s = DEFAULT_HOURLY.map((_, h) => [1, 2, 3, 2, 1].reduce((acc, c, i) => acc + c * DEFAULT_HOURLY[(h + i + 22) % 24], 0) / 9);
    const mean = s.reduce((a, b) => a + b, 0) / 24;
    return s.map((v) => v - mean);
  })();

  // Base horaire commune (v0.18.0) : les meilleures heures de fin sont les
  // mêmes pour toutes les cartes. Pour chaque vente des 30 derniers jours :
  //  - écart (log) entre son prix et la médiane des autres ventes de la même
  //    carte et de la même rareté à ±3 jours : la tendance de la carte (prix
  //    qui monte ou qui baisse) ne passe plus pour un effet de l'heure ;
  //  - écart borné à ±40 % : une vente aberrante ne fait pas une heure ;
  //  - poids 1/√n (n = ventes de la carte) : une carte très vendue ne décide
  //    pas seule du profil.
  // Chaque heure : moyenne pondérée, rapprochée du profil par défaut quand elle
  // a peu de ventes (avant, une heure de nuit à 3 ventes pouvait gagner par
  // hasard), puis lissée sur ±2 h et recentrée sur l'heure moyenne des ventes.
  function buildProfile(store, now) {
    const sum = new Array(24).fill(0);
    const weight = new Array(24).fill(0);
    let used = 0;
    const cards = new Set();
    for (const [cardId, entry] of Object.entries(store)) {
      const groups = {};
      for (const [ts, price, rarity] of entry.s) if (price > 0) (groups[rarity] ||= []).push([ts * 1000, price]);
      for (const list of Object.values(groups)) {
        if (list.length < 5) continue;
        list.sort((a, b) => a[0] - b[0]);
        const overall = quantile(list.map((x) => x[1]).sort(byNumber), 0.5);
        const w = 1 / Math.sqrt(list.length);
        let lo = 0;
        let hi = 0;
        for (let i = 0; i < list.length; i++) {
          const [ts, price] = list[i];
          while (list[lo][0] < ts - 3 * DAY) lo++;
          while (hi < list.length && list[hi][0] <= ts + 3 * DAY) hi++;
          if (now - ts > CONFIG.keepSalesDays * DAY) continue;
          const near = [];
          for (let j = lo; j < hi; j++) if (j !== i) near.push(list[j][1]);
          const ref = near.length >= 4 ? quantile(near.sort(byNumber), 0.5) : overall;
          const h = parisHour(ts);
          sum[h] += w * Math.max(-0.4, Math.min(0.4, Math.log(price / ref)));
          weight[h] += w;
          used++;
          cards.add(cardId);
        }
      }
    }
    const k = CONFIG.profilePriorWeight;
    const raw = sum.map((s, h) => (s + k * DEFAULT_HOURLY[h]) / (weight[h] + k));
    const smooth = raw.map((_, h) => [1, 2, 3, 2, 1].reduce((acc, c, i) => acc + c * raw[(h + i + 22) % 24], 0) / 9);
    // Recentré : les prix conseillés, tirés de ventes à toutes les heures,
    // correspondent à l'heure moyenne des ventes (indice 0).
    const total = weight.reduce((a, b) => a + b, 0);
    const mean = total ? smooth.reduce((acc, v, h) => acc + v * weight[h], 0) / total : smooth.reduce((a, b) => a + b, 0) / 24;
    return { hourly: smooth.map((v) => v - mean), used, cards: cards.size };
  }

  // Indice de la base à un instant (log du rapport au prix habituel),
  // interpolé entre les milieux d'heure : une fin à 20 h 55 et une à 21 h 05
  // sont notées presque pareil. (Paris : décalage d'heures entières.)
  function profileAt(profile, ts) {
    const x = parisHour(ts) + new Date(ts).getUTCMinutes() / 60 - 0.5;
    const h0 = Math.floor(x);
    const f = x - h0;
    const c = profile.reference || profile.hourly;
    return c[(h0 + 24) % 24] * (1 - f) + c[(h0 + 25) % 24] * f;
  }

  // Durées conseillées (v0.18.0), pour chaque prix conseillé : prix estimé
  // selon l'heure de fin (prix × e^indice), puis la durée la plus courte dont
  // le prix estimé est à moins de minLongerGain wikibidous du meilleur. Pas
  // la peine d'attendre plus longtemps pour un gain qui ne compte pas.
  function durationAdvice(profile, rarity, now, prices) {
    const allowed = CONFIG.durations;
    const options = allowed.map((minutes) => {
      const end = now + minutes * 60000;
      return { minutes, end, factor: Math.exp(profileAt(profile, end)) };
    });
    const pick = (price) => {
      if (!price) return null;
      const best = Math.max(...options.map((o) => price * o.factor));
      const o = options.find((x) => best - price * x.factor < CONFIG.minLongerGain) || options[0];
      return { ...o, estimate: Math.round(price * o.factor) };
    };
    const normal = pick(prices.normal);
    // Vaut-il mieux lancer plus tard ? Départs dans les 12 prochaines heures,
    // en journée, seulement si le prix « Normal » estimé y gagne au moins
    // minLongerGain wikibidous.
    let later = null;
    if (normal) {
      for (let offset = 30; offset <= 720; offset += 30) {
        const start = now + offset * 60000;
        const startHour = parisHour(start);
        if (startHour < CONFIG.wakeFromHour || startHour >= CONFIG.wakeToHour) continue;
        for (const minutes of allowed) {
          const estimate = Math.round(prices.normal * Math.exp(profileAt(profile, start + minutes * 60000)));
          if (estimate - normal.estimate >= CONFIG.minLongerGain && (!later || estimate > later.estimate)) {
            later = { start, minutes, end: start + minutes * 60000, estimate, gain: estimate - normal.estimate };
          }
        }
      }
    }
    return { options, quick: pick(prices.quick), normal, ambitious: pick(prices.ambitious), later };
  }

  // ---------------------------------------------------------------------------
  // Lecture de la page
  // ---------------------------------------------------------------------------

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const simplify = (s) => norm(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
  }

  function findButton(regex, root = document) {
    for (const el of root.querySelectorAll('button, [role="button"], [role="tab"]')) {
      if (regex.test(norm(el.textContent)) && isVisible(el)) return el;
    }
    return null;
  }
  // Premier bouton visible pour chacun des textes cherchés, en un seul parcours
  // de la page (v0.17.0 : cardView en faisait trois à chaque tick).
  function findButtons(regexes, root = document) {
    const found = regexes.map(() => null);
    let missing = regexes.length;
    for (const el of root.querySelectorAll('button, [role="button"], [role="tab"]')) {
      const text = norm(el.textContent);
      for (let i = 0; i < regexes.length; i++) {
        if (!found[i] && regexes[i].test(text) && isVisible(el)) {
          found[i] = el;
          missing--;
        }
      }
      if (!missing) break;
    }
    return found;
  }

  const SELL_TEXT = /^mettre aux ench[èe]res$/i;
  const LAUNCH_TEXT = /^lancer l['’]ench[èe]re$/i;
  const MARKET_TAB = /^march[ée]$/i;
  const DETAILS_TAB = /^d[ée]tails$/i;
  const FORBIDDEN = /lancer|confirmer|valider|vendre|d[ée]fausser|supprimer/i;

  // Fenêtre de la carte : l'ancêtre en superposition (dialogue ou position fixe)
  // qui contient « Mettre aux enchères » ou « Lancer l'enchère ».
  // Fenêtre de la carte (relevé réel) : superposition « fixed inset-0 » qui
  // contient un titre h2, la rareté en toutes lettres et les onglets
  // « Détails » / « Marché » (role="tab"). « Mettre aux enchères » n'est
  // visible que sur l'onglet Détails.
  function cardView() {
    const [launch, details, sell] = findButtons([LAUNCH_TEXT, DETAILS_TAB, SELL_TEXT]);
    const anchor = launch || details || sell;
    if (!anchor || anchor.closest('nav, header') || anchor.closest('#wv-panel')) return null;
    let container = null;
    for (let n = anchor.parentElement; n && n !== document.body; n = n.parentElement) {
      if (n.matches('[role="dialog"], [aria-modal="true"]') || getComputedStyle(n).position === 'fixed') {
        container = n;
        break;
      }
    }
    if (!container) return null;
    const marketTab = findButton(MARKET_TAB, container);
    return {
      container,
      formOpen: !!findButton(LAUNCH_TEXT, container),
      onMarket: !!marketTab && marketTab.getAttribute('aria-selected') === 'true',
    };
  }

  function cardTitles(container) {
    return [...container.querySelectorAll('h1, h2, h3, h4')].map((h) => norm(h.textContent)).filter(Boolean);
  }

  // Rareté affichée en toutes lettres (« Légendaire ») ou en code (« L »).
  const RARITY_NAMES = [
    [/^legendaire$/, 'L'], [/^ultra[ -]?rare$/, 'UR'], [/^super[ -]?rare$/, 'SR'],
    [/^peu commune?$/, 'PC'], [/^commune?$/, 'C'], [/^rare$/, 'R'],
  ];
  function rarityCode(text) {
    const t = simplify(text);
    if (RARITIES.includes(norm(text))) return norm(text);
    const hit = RARITY_NAMES.find(([re]) => re.test(t));
    return hit ? hit[1] : null;
  }

  // Carte shiny sur la fiche : pastille shiny, texte « shiny » pour lecteurs
  // d'écran, ou étoile ✦ à côté de la rareté.
  function sheetShiny(container) {
    return isShinyEl(container) || [...container.querySelectorAll('span, div')]
      .some((e) => !e.children.length && e.textContent.length <= 20 && /✦/.test(e.textContent) && !panel.contains(e));
  }

  function cardRarity(container) {
    for (const el of container.querySelectorAll('span, div, p')) {
      if (el.children.length > 0 || el.textContent.length > 14) continue;
      const code = rarityCode(el.textContent);
      if (code && isVisible(el)) return code;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Identifiant de la carte : repéré dans les requêtes que la page fait elle-même
  // (sans lire leur contenu), puis vérifié par le titre.
  // ---------------------------------------------------------------------------

  const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
  const CARD_URLS = [
    new RegExp(`/api/marketplace/cards/${UUID}/sales`, 'i'),
    new RegExp(`/rest/v1/cards\\?[^#]*\\bid=eq\\.${UUID}`, 'i'),
  ];
  const seenIds = [];
  // Listes d'enchères chargées par la page (/api/marketplace?page=…) : relues
  // une fois chacune par l'aide à l'achat. Valeur : heure de lecture (0 = à lire).
  const LIST_URL = /\/api\/marketplace\?/i;
  const listUrls = new Map();
  function noteUrl(url) {
    if (LIST_URL.test(url) && !listUrls.has(url)) listUrls.set(url, 0);
    // L'identifiant du compte n'est plus pris dans les requêtes de profil
    // (v1.4.0) : une requête peut concerner un autre joueur. Voir noteFollowed.
    // Lectures du script lui-même : ce ne sont pas des cartes ouvertes par la page.
    if (ownUrls.has(url)) return;
    for (const re of CARD_URLS) {
      const m = re.exec(url);
      if (m) {
        const id = m[1].toLowerCase();
        const i = seenIds.indexOf(id);
        if (i >= 0) seenIds.splice(i, 1);
        seenIds.unshift(id);
        if (seenIds.length > 20) seenIds.pop();
      }
    }
  }
  try {
    new PerformanceObserver((list) => list.getEntries().forEach((e) => noteUrl(e.name)))
      .observe({ type: 'resource', buffered: true });
  } catch (err) {
    log('PerformanceObserver indisponible', err);
  }

  // ---------------------------------------------------------------------------
  // Ventes : même source que l'onglet « Marché », avec la session de l'utilisateur.
  // ---------------------------------------------------------------------------

  const salesCache = new Map();
  let lastFetch = '—';
  // Historiques complets gardés en mémoire vive : 200 cartes au plus, les plus
  // anciennes lues effacées d'abord (v1.4.0 ; avant, sans limite). Les résumés
  // suffisent aux pastilles.
  function cacheSales(cardId, data) {
    salesCache.delete(cardId);
    salesCache.set(cardId, { at: Date.now(), data });
    while (salesCache.size > 200) salesCache.delete(salesCache.keys().next().value);
  }

  // kind : 'urgent' (fiche ouverte, page d'une enchère) ou 'bulk' (pastilles,
  // plafonds de la télécommande), pour le portier de débit. Les pastilles
  // n'alimentent pas la base horaire (écritures lourdes dans Tampermonkey
  // quand des dizaines de cartes sont lues d'affilée).
  // Mesures des lectures (diagnostic) : réussites, erreurs par code, durées.
  const readStats = { ok: 0, errors: {}, totalMs: 0, maxMs: 0, recent: [], inflightMax: 0 };
  const ownUrls = new Set(); // lectures du script, ignorées par la lecture des réponses de la page
  async function fetchSales(cardId, maxAgeMs = 5 * 60000, kind = 'urgent') {
    const cached = salesCache.get(cardId);
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.data;
    const url = `/api/marketplace/cards/${cardId}/sales`;
    const full = `${location.origin}${url}`;
    await gateWait(kind, full);
    const started = Date.now();
    ownUrls.add(full);
    let res;
    try {
      res = await pageFetch(url);
    } catch (err) {
      readStats.errors.réseau = (readStats.errors.réseau || 0) + 1;
      throw err;
    } finally {
      setTimeout(() => ownUrls.delete(full), 5000);
    }
    lastFetch = `${url} → ${res.status}`;
    if (!res.ok) {
      readStats.errors[res.status] = (readStats.errors[res.status] || 0) + 1;
      if (isRateRefusal(res.status, full)) {
        readStats.refused = (readStats.refused || 0) + 1;
        gate.refused(res.status);
      }
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.retryAfter = Number(res.headers.get('retry-after')) || 0;
      throw err;
    }
    // Page HTML servie en 200 (session expirée, redirection) : pas un historique.
    let data;
    try {
      data = await res.json();
    } catch (err) {
      readStats.errors['pas du JSON'] = (readStats.errors['pas du JSON'] || 0) + 1;
      throw new Error('réponse qui n’est pas du JSON (session expirée ?)');
    }
    if (!data || !Array.isArray(data.sales)) throw new Error('réponse sans historique des ventes');
    const ms = Date.now() - started;
    readStats.ok++;
    readStats.totalMs += ms;
    readStats.maxMs = Math.max(readStats.maxMs, ms);
    readStats.recent.push(ms);
    if (readStats.recent.length > 10) readStats.recent.shift();
    cacheSales(cardId, data);
    if (kind !== 'bulk') rememberSales(cardId, data.sales);
    summarize(cardId, data.sales, data.wikipedia_title);
    markShinyChecked(cardId);
    return data;
  }

  // Base de ventes pour le profil horaire : [horodatage en s, prix, rareté], par
  // carte ; seulement les keepSalesDays derniers jours, 300 cartes au plus.
  // Le profil est recalculé seulement quand la base change.
  // Écritures groupées : sur le marché, plusieurs cartes sont lues à la suite.
  let profileCache = null;
  let pendingSales = {};
  let flushTimer = null;
  function rememberSales(cardId, sales) {
    const since = Date.now() - CONFIG.keepSalesDays * DAY;
    pendingSales[cardId] = {
      at: Date.now(),
      s: sales.filter((x) => Date.parse(x.settled_at) >= since)
        .map((x) => [Math.round(Date.parse(x.settled_at) / 1000), x.final_price, x.rarity]),
    };
    if (!flushTimer) flushTimer = setTimeout(flushSales, 5000);
  }
  function flushSales() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!Object.keys(pendingSales).length) return;
    const store = Object.assign(GM_getValue(KEY_SALES, {}), pendingSales);
    pendingSales = {};
    const ids = Object.keys(store).sort((a, b) => store[b].at - store[a].at);
    for (const id of ids.slice(300)) delete store[id];
    GM_setValue(KEY_SALES, store);
    profileCache = null;
  }
  addEventListener('pagehide', flushSales);

  function currentProfile(now) {
    flushSales();
    if (!profileCache || now - profileCache.at > 10 * 60000) {
      const measured = buildProfile(GM_getValue(KEY_SALES, {}), now);
      profileCache = { at: now, profile: { ...measured, reference: CONFIG.useMeasuredProfile ? measured.hourly : GRAPH_HOURLY } };
    }
    return profileCache.profile;
  }

  // Écriture groupée d'une grosse mémoire (résumés, titres) : la mémoire vive
  // fait foi ; on ne relit Tampermonkey (plusieurs Mo) que si un autre onglet
  // a écrit depuis notre dernière écriture (jeton de version, clé à part).
  const writeTokens = {};
  function mergeStore(key, mem, pending) {
    const token = GM_getValue(`${key}.rev`, null);
    const store = token !== null && token === writeTokens[key] ? mem : Object.assign(GM_getValue(key, {}), pending);
    return store;
  }
  function commitStore(key, store) {
    GM_setValue(key, store);
    writeTokens[key] = Math.random().toString(36).slice(2);
    GM_setValue(`${key}.rev`, writeTokens[key]);
  }

  // Résumé compact par carte et par rareté (et par rareté shiny : « L✦ »),
  // pour les pastilles : [médiane, ventes, plafond revente, plafond à garder,
  // valeur de revente, prix « Normal », ventes sur 7 jours, « Vente rapide »].
  // Gardé summaryHours heures, maxSummaries cartes au plus, écrit par lots.
  // t : titre de la carte donné par la lecture des ventes (même format que
  // l'aide à la vente de l'ordinateur).
  let summaries = GM_getValue(KEY_SUMMARY, {});
  let pendingSummaries = {};
  let summaryTimer = null;
  function summarize(cardId, sales, title = null) {
    const now = Date.now();
    const r = {};
    for (const rarity of new Set(sales.map((x) => x.rarity))) {
      for (const shiny of [false, true]) {
        if (shiny && !sales.some((x) => x.rarity === rarity && isShinySale(x))) continue;
        const pool = salesPool(sales, rarity, now, shiny);
        const a = buyAdvice(sales, rarity, now, shiny, pool);
        const pa = a.enough ? priceAdvice(sales, rarity, now, shiny, pool) : null;
        r[shiny ? `${rarity}✦` : rarity] = a.enough
          ? [a.median, a.n, a.resaleCap, a.keepCap, a.resale === null ? null : Math.round(a.resale), pa.normal, sales7d(sales, rarity, now, shiny), pa.quick,
            span10d(sales, rarity, shiny) ?? -1, sales48h(sales, rarity, now, shiny)]
          : [null, a.n];
      }
    }
    learnShiny(cardId, sales);
    checkJoin(cardId, sales);
    const t = typeof title === 'string' && title ? title : (summaries[cardId] && summaries[cardId].t) || null;
    summaries[cardId] = pendingSummaries[cardId] = { at: now, r, t };
    if (!summaryTimer) summaryTimer = setTimeout(flushSummaries, 15000);
  }
  function flushSummaries() {
    clearTimeout(summaryTimer);
    summaryTimer = null;
    if (!Object.keys(pendingSummaries).length) return;
    const store = mergeStore(KEY_SUMMARY, summaries, pendingSummaries);
    pendingSummaries = {};
    const ids = Object.keys(store);
    if (ids.length > CONFIG.maxSummaries) {
      ids.sort((a, b) => store[b].at - store[a].at);
      for (const id of ids.slice(CONFIG.maxSummaries)) delete store[id];
    }
    commitStore(KEY_SUMMARY, store);
    summaries = store;
  }
  addEventListener('pagehide', flushSummaries);
  // Résumé d'une carte, même ancien (stale = à relire en arrière-plan) :
  // la pastille s'affiche tout de suite avec la dernière valeur connue.
  function summaryFor(cardId, rarity, hours = CONFIG.buy.summaryHours) {
    const e = summaries[cardId];
    if (!e) return null;
    const stale = Date.now() - e.at > hours * 3600000;
    const v = e.r[rarity];
    if (!v) return stale ? null : { median: null, n: 0, normal: null, t: e.t || null };
    // Résumé d'avant la v0.8 (sans prix « Normal ») : à relire.
    if (v[0] !== null && v.length < 6) return null;
    // Résumé d'avant la v0.9.2 (sans ventes sur 7 jours) : affiché, et relu.
    return { median: v[0], n: v[1], resaleCap: v[2] ?? null, keepCap: v[3] ?? null, resale: v[4] ?? null, normal: v[5] ?? null,
      sales7: v[6] ?? null, sales48: v.length >= 10 ? v[9] : undefined, quick: v[7] ?? null, span10: v[8] === undefined ? undefined : v[8] < 0 ? null : v[8],
      stale: stale || (v[0] !== null && v.length < 7), t: e.t || null };
  }

  // ---------------------------------------------------------------------------
  // Cartes shiny : prime mesurée sur toutes les cartes
  // ---------------------------------------------------------------------------
  // Pour chaque vente shiny connue : rapport entre son prix et la médiane des
  // ventes normales de la même carte, même rareté, à ±baselineDays jours (3
  // ventes au moins). Une carte compte une fois (moyenne de ses log-rapports),
  // puis médiane entre cartes (robuste aux cas extrêmes), avec un intervalle
  // de confiance à 90 % par bootstrap (500 tirages, sur les cartes). Par
  // rareté dès minCards cartes, sinon toutes raretés confondues.

  const KEY_SHINY_AUCTIONS = 'wv.shinyAuctions'; // enchère shiny → [carte, rareté, fin (s)]
  const KEY_SHINY_PAIRS = 'wv.shinyPairs'; // vente shiny → [carte, rareté, prix, référence normale, date (s)]
  const KEY_JOIN = 'wv.joinCheck'; // enchère vendue → [carte, prix, résultat du contrôle]
  const KEY_BOUGHT = 'wv.bought'; // enchère gagnée → [carte, prix, date (s), rareté, shiny, titre]
  shinyAuctions = GM_getValue(KEY_SHINY_AUCTIONS, {});
  let shinyPairs = GM_getValue(KEY_SHINY_PAIRS, {});
  let joinCheck = GM_getValue(KEY_JOIN, {});
  let bought = GM_getValue(KEY_BOUGHT, {});
  const smallStores = { [KEY_SHINY_AUCTIONS]: 4000, [KEY_SHINY_PAIRS]: 6000, [KEY_JOIN]: 400, [KEY_BOUGHT]: 2000 };
  const dirtySmall = new Set();
  let smallTimer = null;
  function touch(key) {
    dirtySmall.add(key);
    if (!smallTimer) smallTimer = setTimeout(flushSmall, 5000);
  }
  function flushSmall() {
    clearTimeout(smallTimer);
    smallTimer = null;
    const mem = { [KEY_SHINY_AUCTIONS]: shinyAuctions, [KEY_SHINY_PAIRS]: shinyPairs, [KEY_JOIN]: joinCheck, [KEY_BOUGHT]: bought };
    for (const key of dirtySmall) {
      // Fusion avec ce qu'un autre onglet a pu écrire, gardée aussi en mémoire vive.
      const store = Object.assign(GM_getValue(key, {}), mem[key]);
      const ids = Object.keys(store);
      for (const id of ids.slice(0, Math.max(0, ids.length - smallStores[key]))) delete store[id];
      GM_setValue(key, store);
      if (key === KEY_SHINY_AUCTIONS) shinyAuctions = store;
      else if (key === KEY_SHINY_PAIRS) shinyPairs = store;
      else if (key === KEY_JOIN) joinCheck = store;
      else bought = store;
    }
    dirtySmall.clear();
  }
  addEventListener('pagehide', flushSmall);

  function learnShiny(cardId, sales) {
    let added = 0;
    for (const s of sales) {
      if (!s.id || !isShinySale(s) || shinyPairs[s.id]) continue;
      const t = tsOf(s);
      const near = sales.filter((x) => x.rarity === s.rarity && !isShinySale(x) && Math.abs(tsOf(x) - t) <= CONFIG.shiny.baselineDays * DAY)
        .map((x) => x.final_price).sort(byNumber);
      if (near.length < 3 || !(s.final_price > 0)) continue;
      shinyPairs[s.id] = [cardId, s.rarity, s.final_price, quantile(near, 0.5), Math.round(t / 1000)];
      added++;
    }
    if (added) {
      premiumCache = null;
      touch(KEY_SHINY_PAIRS);
    }
  }

  // Contrôle « même identifiant pour l'enchère et la vente » : les enchères
  // vendues dont on connaît le prix (notifications « carte vendue », listes
  // « Mes enchères ») doivent se retrouver telles quelles dans les ventes.
  function checkJoin(cardId, sales) {
    let changed = false;
    for (const [auctionId, e] of Object.entries(joinCheck)) {
      if (e[0] !== cardId || e[2]) continue;
      const sale = sales.find((x) => x.id === auctionId);
      e[2] = sale ? (sale.final_price === e[1] ? 'ok' : 'prix') : 'absente';
      changed = true;
    }
    if (sales.some((x) => 'is_shiny' in x || 'shiny' in x)) shinyField = true;
    if (changed) touch(KEY_JOIN);
  }
  let shinyField = false;

  let premiumCache = null;
  function premiumEstimate(values) {
    const byCard = new Map();
    for (const [key, x] of values) (byCard.get(key) || byCard.set(key, []).get(key)).push(x);
    const vals = [...byCard.values()].map((xs) => xs.reduce((a, b) => a + b, 0) / xs.length).sort(byNumber);
    const m = vals.length;
    if (m < CONFIG.shiny.minCards) return { cards: m, sales: values.length, beta: null };
    let seed = 20260926;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const boots = [];
    for (let b = 0; b < 500; b++) {
      const sample = Array.from({ length: m }, () => vals[Math.floor(rnd() * m)]).sort(byNumber);
      boots.push(quantile(sample, 0.5));
    }
    boots.sort(byNumber);
    return {
      cards: m,
      sales: values.length,
      beta: Math.exp(quantile(vals, 0.5)) - 1,
      lo: Math.exp(quantile(boots, 0.05)) - 1,
      hi: Math.exp(quantile(boots, 0.95)) - 1,
    };
  }
  function shinyPremiums() {
    if (premiumCache && Date.now() - premiumCache.at < 60000) return premiumCache;
    const all = [];
    const byRarity = {};
    for (const [cardId, rarity, price, base] of Object.values(shinyPairs)) {
      const x = Math.log(price / base);
      if (!Number.isFinite(x)) continue;
      all.push([`${cardId}|${rarity}`, x]);
      (byRarity[rarity] ||= []).push([`${cardId}|${rarity}`, x]);
    }
    premiumCache = { at: Date.now(), all: premiumEstimate(all), byRarity: {} };
    for (const [r, list] of Object.entries(byRarity)) premiumCache.byRarity[r] = premiumEstimate(list);
    return premiumCache;
  }
  // Prime à appliquer pour une rareté : celle de la rareté si elle est
  // mesurée, sinon toutes raretés confondues, sinon null (pas assez de données).
  function premiumFor(rarity) {
    const p = shinyPremiums();
    const own = p.byRarity[rarity];
    if (own && own.beta !== null) return { ...own, scope: rarity };
    if (p.all.beta !== null) return { ...p.all, scope: 'toutes raretés' };
    return null;
  }
  const fmtPremium = (p) => `${p.beta >= 0 ? '+' : ''}${Math.round(p.beta * 100)} % (90 % de confiance : ${Math.round(p.lo * 100)} à ${Math.round(p.hi * 100)} %, ${p.cards} cartes${p.scope ? `, ${p.scope}` : ''})`;

  // Valeur d'une carte (résumé) selon sa version : shiny → ses propres ventes
  // shiny (ownMinSales au moins), sinon valeur normale × (1 + prime), sinon
  // valeur normale signalée comme sous-estimée (shinyVia = 'inconnue').
  function valueFor(cardId, rarity, shiny, hours) {
    const base = summaryFor(cardId, rarity, hours);
    if (!shiny || !base) return base;
    const own = summaryFor(cardId, `${rarity}✦`, hours);
    if (own && own.median !== null && own.n >= CONFIG.shiny.ownMinSales) return { ...own, stale: base.stale, shinyVia: 'ventes' };
    const p = premiumFor(rarity);
    if (!p || base.median === null) return { ...base, shinyVia: 'inconnue' };
    const k = 1 + p.beta;
    const up = (x) => (x == null ? x : Math.round(x * k));
    const cap = (x) => (x == null ? x : Math.floor(x * k));
    return { ...base, median: up(base.median), normal: up(base.normal), quick: up(base.quick), resale: up(base.resale),
      resaleCap: cap(base.resaleCap), keepCap: cap(base.keepCap), shinyVia: 'prime', premium: p };
  }
  // Même chose pour les conseils complets (fiche, page d'une enchère).
  function shinyAdvice(sales, rarity) {
    const own = adviceFor(sales, rarity, true);
    if (own.buy.enough && own.buy.n >= CONFIG.shiny.ownMinSales) return { ...own, via: 'ventes' };
    const base = adviceFor(sales, rarity, false);
    const p = premiumFor(rarity);
    if (!p || !base.buy.enough) return { ...base, via: 'inconnue' };
    const k = 1 + p.beta;
    const up = (x) => (x == null ? x : Math.round(x * k));
    const cap = (x) => (x == null ? x : Math.floor(x * k));
    const pr = base.price;
    const b = base.buy;
    return {
      at: base.at,
      sales7: base.sales7,
      span10: base.span10,
      via: 'prime',
      premium: p,
      price: pr.enough ? { ...pr, quick: up(pr.quick), normal: up(pr.normal), ambitious: up(pr.ambitious), min: up(pr.min), median: up(pr.median), max: up(pr.max) } : pr,
      buy: { ...b, median: up(b.median), min: up(b.min), max: up(b.max), keepCap: cap(b.keepCap), resaleCap: cap(b.resaleCap), resale: up(b.resale),
        percentile: (price) => b.percentile(price / k) },
    };
  }

  // Mémoire « titre → identifiant » : une carte reconnue une fois l'est ensuite
  // sans aucun clic, même après rechargement de la page.
  // Au plus maxIds titres, les plus anciens effacés d'abord (ordre d'ajout).
  // Gardée en mémoire vive (lue une fois), écrite dans Tampermonkey par lots :
  // la relire à chaque rafraîchissement coûtait cher sur la tablette.
  let idsMem = GM_getValue(KEY_IDS, {});
  let pendingIds = {};
  let idsTimer = null;
  const rememberId = (title, id) => rememberIds([[title, id]]);
  function rememberIds(pairs) {
    for (const [title, id] of pairs) {
      const key = simplify(title);
      if (key && id && idsMem[key] !== id) {
        delete idsMem[key];
        idsMem[key] = id;
        pendingIds[key] = id;
      }
    }
    if (Object.keys(pendingIds).length && !idsTimer) idsTimer = setTimeout(flushIds, 3000);
  }
  function flushIds() {
    clearTimeout(idsTimer);
    idsTimer = null;
    if (!Object.keys(pendingIds).length && !forgetPending) return;
    const token = GM_getValue(`${KEY_IDS}.rev`, null);
    let ids = idsMem;
    if (token === null || token !== writeTokens[KEY_IDS]) {
      // Un autre onglet a écrit : on repart de sa version.
      ids = GM_getValue(KEY_IDS, {});
      for (const [key, id] of Object.entries(pendingIds)) {
        delete ids[key];
        ids[key] = id;
      }
    }
    // Identifiants oubliés (carte introuvable) : retirés aussi de la version
    // d'un autre onglet.
    for (const [key, id] of Object.entries(ids)) if (deadIds.has(id)) delete ids[key];
    pendingIds = {};
    forgetPending = false;
    const keys = Object.keys(ids);
    for (const key of keys.slice(0, Math.max(0, keys.length - CONFIG.maxIds))) delete ids[key];
    commitStore(KEY_IDS, ids);
    idsMem = ids;
  }
  addEventListener('pagehide', flushIds);
  // Identifiant d'une carte introuvable sur le site (404 répétés) : plus relu
  // pendant la session, et oublié dans la mémoire « titre → identifiant ».
  const deadIds = new Set();
  let forgetPending = false;
  function forgetId(id) {
    if (deadIds.has(id)) return;
    deadIds.add(id);
    for (const [key, value] of Object.entries(idsMem)) {
      if (value === id) {
        delete idsMem[key];
        forgetPending = true;
      }
    }
    log('Carte introuvable, identifiant oublié :', id);
    if (forgetPending && !idsTimer) idsTimer = setTimeout(flushIds, 3000);
  }
  const knownId = (title) => idsMem[simplify(title)] || null;
  const autoOpenAllowed = () => GM_getValue(KEY_AUTO_OPEN, CONFIG.autoOpenMarket);
  let autoClicks = 0;

  // Minuteries fiables en arrière-plan (Web Worker, comme les deux autres bots) :
  // Chrome ralentit les setTimeout d'un onglet caché, jusqu'à un réveil par
  // minute, ce qui figeait le nettoyage dès qu'on changeait d'onglet. Le worker
  // ne sert qu'après avoir répondu une première fois (une politique de sécurité
  // du site pourrait le bloquer sans erreur) ; sinon, setTimeout.
  const timers = new Map();
  let timerSeq = 0;
  let worker = null;
  let workerOk = false;
  try {
    worker = new Worker(URL.createObjectURL(new Blob(['onmessage=e=>setTimeout(()=>postMessage(e.data.id),e.data.ms)'], { type: 'text/javascript' })));
    worker.onmessage = (e) => {
      workerOk = true;
      const fn = timers.get(e.data);
      timers.delete(e.data);
      if (fn) fn();
    };
    worker.onerror = () => {
      worker = null;
    };
    worker.postMessage({ id: 0, ms: 0 });
  } catch (err) {
    log('Worker indisponible, repli sur setTimeout', err);
  }
  function later(fn, ms) {
    if (!worker || !workerOk) return void setTimeout(fn, ms);
    const id = ++timerSeq;
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      timers.delete(id);
      clearTimeout(backup);
      fn();
    };
    const backup = setTimeout(once, ms + 60000); // si le worker cesse de répondre
    timers.set(id, once);
    worker.postMessage({ id, ms: Math.max(0, Math.round(ms)) });
  }
  const sleep = (ms) => new Promise((r) => later(r, ms));

  // ---------------------------------------------------------------------------
  // Débit vers le site : aucun refus (portier commun à l'aide à la vente et à
  // la surenchère ; même code dans les deux scripts)
  // ---------------------------------------------------------------------------
  // Le site refuse (403) les requêtes quand il en reçoit trop. Aucune requête
  // d'un script ne part sans l'accord de ce portier, qui compte toutes les
  // requêtes /api/ du navigateur : celles des deux scripts et celles de la page
  // elle-même (vues par l'aide à la vente), dans tous les onglets, par un canal
  // commun (BroadcastChannel « wm-gate »).
  // - Deux plafonds glissants : perTen requêtes en 10 s, perMin en 60 s.
  // - Lectures de fond (pastilles, plafonds) : 70 % des plafonds au plus ;
  //   nettoyage de la collection : 90 % ; le reste est gardé pour l'urgent
  //   (enchère qui se termine, fiche ouverte, page d'une enchère). Les lectures
  //   juste avant une mise passent même pendant une pause, jamais au-delà des
  //   plafonds.
  // - Réglage (v0.20.0) : départ à 8 en 10 s et 40 par minute, puis +2 et +8
  //   toutes les 30 s passées au plafond, jusqu'à 25 et 130 (avant : 15 et 75,
  //   montée deux fois plus lente), sous le débit refusé en réel (environ 3
  //   requêtes/s, v0.9.3). Le réglage atteint est gardé.
  // - Refus (v0.20.1, moins strict qu'en v0.20.0) : quelques refus sont
  //   tolérés, le 3e rapproché calme le jeu. 1er refus : pause de 10 s. 2e en
  //   moins de 2 min : pause de 30 s et plafonds −10 % (la montée reprend
  //   ensuite). 3e en moins de 2 min : plafonds à 80 %, fixés 1 h et transmis
  //   à l'autre script, pause de 2 min (4, puis 8 min si les refus continuent
  //   dans le quart d'heure). Un 503 (site surchargé ou en maintenance) donne
  //   une pause (30 s, puis 1, 2… 5 min au plus), sans toucher aux plafonds.
  function makeGate(storeKey) {
    const START = { perTen: 8, perMin: 40 };
    const TOP = { perTen: 25, perMin: 130 };
    const FLOOR = { perTen: 2, perMin: 8 };
    const UNLOCK_MS = 3600000;
    // Plafonds fixés par des refus vieux de plus d’1 h : la montée peut reprendre.
    const expired = (c) => !!c && !!c.locked && Date.now() - (c.lastRefusal || 0) > UNLOCK_MS;
    let cfg = { ...START, locked: false, refusals: 0, lastRefusal: 0, ...GM_getValue(storeKey, {}) };
    if (expired(cfg)) cfg = { ...cfg, locked: false };
    const recent = []; // [heure, adresse, identifiant] des requêtes des 60 dernières secondes
    const seen = new Set();
    let pausedUntil = 0;
    let strikes = 0;
    let lastStrikeAt = 0;
    let climbAt = Date.now();
    let saturatedAt = 0;
    let chan = null;
    const save = () => GM_setValue(storeKey, cfg);
    function prune(now) {
      while (recent.length && recent[0][0] < now - 60000) seen.delete(recent.shift()[2]);
    }
    // Une même requête peut être vue deux fois (par le script qui l'envoie et
    // par l'aide à la vente qui observe la page) : même adresse à 1,5 s près.
    function record(at, url, id, remote) {
      if (seen.has(id)) return;
      if (url && recent.some((e) => e[1] === url && Math.abs(e[0] - at) < 1500)) return;
      seen.add(id);
      recent.push([at, url || '', id]);
      if (recent.length > 1 && recent[recent.length - 2][0] > at) recent.sort((a, b) => a[0] - b[0]);
      if (!remote && chan) chan.postMessage({ t: 'req', at, url, id });
    }
    const newId = () => Math.random().toString(36).slice(2, 11);
    const inWindow = (now, ms) => {
      let n = 0;
      for (let i = recent.length - 1; i >= 0 && recent[i][0] > now - ms; i--) n++;
      return n;
    };
    const limits = (kind) => {
      const share = kind === 'bulk' ? 0.7 : kind === 'clean' ? 0.9 : 1;
      return [[10000, Math.max(1, Math.floor(cfg.perTen * share))], [60000, Math.max(1, Math.floor(cfg.perMin * share))]];
    };
    // Attente avant la prochaine requête permise (0 : tout de suite). « critical »
    // (lecture juste avant de miser) passe outre une pause, jamais les plafonds.
    function delay(kind = 'bulk') {
      const now = Date.now();
      prune(now);
      let wait = kind === 'critical' ? 0 : pausedUntil - now;
      for (const [ms, max] of limits(kind)) {
        if (inWindow(now, ms) >= max) wait = Math.max(wait, recent[recent.length - max][0] + ms - now + 25);
      }
      if (wait > 0 && kind !== 'critical' && now >= pausedUntil) saturatedAt = now;
      return Math.max(0, wait);
    }
    // Montée douce, seulement quand la demande dépasse le plafond depuis un moment.
    function climb(now) {
      if (expired(cfg)) {
        cfg = { ...cfg, locked: false };
        save();
      }
      if (cfg.locked || now - climbAt < 30000 || now - saturatedAt > 15000) return;
      climbAt = now;
      const perTen = Math.min(TOP.perTen, cfg.perTen + 2);
      const perMin = Math.min(TOP.perMin, cfg.perMin + 8);
      if (perTen === cfg.perTen && perMin === cfg.perMin) return;
      Object.assign(cfg, { perTen, perMin });
      save();
    }
    // Réserve une place si elle est libre (true), sinon false.
    function take(kind = 'bulk', url = '') {
      if (delay(kind) > 0) return false;
      const now = Date.now();
      climb(now);
      record(now, url, newId(), false);
      return true;
    }
    function adopt(other, until) {
      if (until) pausedUntil = Math.max(pausedUntil, until);
      if (!other || !other.locked || expired(other)) return;
      const perTen = cfg.locked ? Math.min(cfg.perTen, other.perTen) : other.perTen;
      const perMin = cfg.locked ? Math.min(cfg.perMin, other.perMin) : other.perMin;
      if (cfg.locked && perTen === cfg.perTen && perMin === cfg.perMin) return;
      cfg = { ...cfg, perTen, perMin, locked: true, refusals: Math.max(cfg.refusals || 0, other.refusals || 0),
        lastRefusal: Math.max(cfg.lastRefusal || 0, other.lastRefusal || 0) };
      save();
    }
    let calmAt = 0;
    let calmStrikes = 0;
    function refused(status) {
      const now = Date.now();
      if (now < pausedUntil) return; // même salve : déjà traitée
      prune(now);
      strikes = now - lastStrikeAt < 2 * 60000 ? strikes + 1 : 1;
      lastStrikeAt = now;
      let pause = 10000;
      if (status === 503) {
        pause = Math.min(300000, 30000 * 2 ** (strikes - 1));
      } else if (strikes === 2) {
        cfg = { ...cfg, perTen: Math.max(FLOOR.perTen, Math.floor(cfg.perTen * 0.9)), perMin: Math.max(FLOOR.perMin, Math.floor(cfg.perMin * 0.9)) };
        pause = 30000;
      } else if (strikes >= 3) {
        // On calme le jeu : 3 refus rapprochés.
        calmStrikes = now - calmAt < 15 * 60000 ? calmStrikes + 1 : 1;
        calmAt = now;
        cfg = { ...cfg, perTen: Math.max(FLOOR.perTen, Math.floor(cfg.perTen * 0.8)), perMin: Math.max(FLOOR.perMin, Math.floor(cfg.perMin * 0.8)),
          locked: true, refusals: (cfg.refusals || 0) + 1, lastRefusal: now, lastStatus: status };
        pause = Math.min(480000, 120000 * 2 ** (calmStrikes - 1));
        strikes = 0;
      }
      pausedUntil = now + pause;
      save();
      if (chan) chan.postMessage({ t: 'refused', cfg, pausedUntil });
      log(`Refus du site (${status}) : plafonds ${cfg.perTen} / 10 s et ${cfg.perMin} / min, pause jusqu’à ${new Date(pausedUntil).toLocaleTimeString('fr-FR')}`);
    }
    function reset() {
      cfg = { ...START, locked: false, refusals: 0, lastRefusal: 0 };
      save();
      if (chan) chan.postMessage({ t: 'reset' });
    }
    try {
      chan = new BroadcastChannel('wm-gate');
      chan.onmessage = (e) => {
        const m = e.data || {};
        if (m.t === 'req') record(m.at, m.url, m.id, true);
        else if (m.t === 'refused') adopt(m.cfg, m.pausedUntil);
        else if (m.t === 'hello') chan.postMessage({ t: 'state', list: recent.slice(-300), cfg, pausedUntil });
        else if (m.t === 'state') {
          for (const [at, url, id] of m.list || []) record(at, url, id, true);
          adopt(m.cfg, m.pausedUntil);
        } else if (m.t === 'reset') {
          cfg = { ...START, locked: false, refusals: 0, lastRefusal: 0 };
          save();
        }
      };
      chan.postMessage({ t: 'hello' });
    } catch (err) {
      log('Canal commun indisponible : chaque script compte seul ses requêtes', err);
    }
    const status = () => {
      const now = Date.now();
      prune(now);
      return `plafonds ${cfg.perTen} / 10 s et ${cfg.perMin} / min (${cfg.locked
        ? `fixés après ${cfg.refusals} refus, le dernier ${new Date(cfg.lastRefusal).toLocaleString('fr-FR')} ; nouvelle montée possible après ${new Date(cfg.lastRefusal + UNLOCK_MS).toLocaleString('fr-FR')}`
        : `réglage en cours, jusqu’à ${TOP.perTen} et ${TOP.perMin}`}) · requêtes vues : ${inWindow(now, 10000)} en 10 s, ${inWindow(now, 60000)} en 60 s`
        + (now < pausedUntil ? ` · pause jusqu’à ${new Date(pausedUntil).toLocaleTimeString('fr-FR')}` : '');
    };
    return { take, delay, refused, reset, status, seen: (url, at = Date.now()) => record(at, url, newId(), false), pausedUntil: () => pausedUntil };
  }
  // Refus liés au débit : 429, 503, et 403 sur les lectures du marché (seul cas
  // relevé). Une mise refusée (/bid) n'en est pas un.
  const isRateRefusal = (status, url = '') => status === 429 || status === 503
    || (status === 403 && /\/api\/marketplace/.test(url) && !/\/bid\b/.test(url));

  const gate = makeGate('wv.gate');
  // Attend l'accord du portier, puis réserve la place de la requête.
  async function gateWait(kind, url) {
    for (;;) {
      if (gate.take(kind, url)) return;
      await sleep(Math.min(5000, Math.max(50, gate.delay(kind))));
    }
  }
  earlyRequests.splice(0).forEach(([url, at]) => gate.seen(url, at));
  onPageRequest = (url) => gate.seen(url);
  onPageStatus = (status, url) => {
    if (isRateRefusal(status, url)) gate.refused(status);
  };

  // Trouve l'identifiant de la carte affichée : parmi les requêtes vues, celle
  // dont les ventes portent le même titre que la fiche.
  // Le titre de la carte figure-t-il dans la fenêtre (mot entier) ?
  // Le titre de la carte est-il celui d'un des titres (h1–h4) de la fenêtre ?
  // (textContent colle les textes : « Marc LavoineLégendaire ».)
  function showsTitle(container, title) {
    const t = simplify(title);
    return !!t && cardTitles(container).some((h) => simplify(h) === t);
  }

  // Repère la carte affichée, du moins coûteux au plus visible :
  //   1. mémoire « titre → identifiant » (carte déjà vue) ;
  //   2. identifiants des requêtes que la page vient de faire ;
  //   3. sinon, tout de suite : ouvrir « Marché » UNE fois pour
  //      cette fenêtre (la page lit alors les ventes), puis revenir sur « Détails ».
  // Chaque identifiant est vérifié : le titre de ses ventes doit être celui de la fiche.
  async function resolveCard(view, shiny = false) {
    const titles = cardTitles(view.container);
    const tryIds = async (ids) => {
      for (const id of ids) {
        try {
          const data = await fetchSales(id);
          if (data && showsTitle(view.container, data.wikipedia_title)) {
            rememberId(shiny ? `${data.wikipedia_title} ✦` : data.wikipedia_title, id);
            return { id, data };
          }
        } catch (err) {
          log('Lecture des ventes impossible', id, err.message);
          // v1.4.0 : un 403 n'est pas une session expirée (le site répond 403
          // quand il limite les lectures) ; recharger ne ferait que repasser
          // la vérification humaine.
          if (err.status === 401) state.error = 'Session expirée : recharge la page et reconnecte-toi.';
          else if (err.status === 403) state.error = 'Lecture refusée par le site (403) : trop de lectures d’affilée, ou accès à l’historique des ventes refusé (abonnement PRO ?). Nouvel essai dans un instant.';
        }
      }
      return null;
    };
    const remembered = [...(shiny ? titles.map((t) => knownId(`${t} ✦`)) : []), ...titles.map(knownId)].filter(Boolean);
    const found = await tryIds([...new Set([...remembered, ...seenIds.slice(0, 4)])]);
    if (found || state.autoTried || view.onMarket || !autoOpenAllowed()) return found;
    if (Date.now() - state.openedAt < CONFIG.autoOpenDelayMs) return null;
    const marketTab = findButton(MARKET_TAB, view.container);
    if (!marketTab || FORBIDDEN.test(norm(marketTab.textContent))) return null;
    state.autoTried = true;
    autoClicks++;
    log('Ouverture de l’onglet Marché pour repérer la carte (une seule fois pour cette carte)');
    const before = seenIds[0];
    marketTab.click();
    for (let i = 0; i < 60 && seenIds[0] === before; i++) await sleep(100);
    await sleep(150);
    const detailsTab = findButton(DETAILS_TAB, view.container);
    if (detailsTab) detailsTab.click();
    return tryIds(seenIds.slice(0, 4));
  }

  // ---------------------------------------------------------------------------
  // Remplissage du formulaire (jamais de clic sur « Lancer l'enchère »)
  // ---------------------------------------------------------------------------

  function priceInput(container) {
    const inputs = [...container.querySelectorAll('input')].filter((i) => isVisible(i) && !['checkbox', 'radio', 'hidden'].includes(i.type));
    const labelled = inputs.find((i) => /prix|minimum|mise/i.test(`${i.placeholder} ${i.getAttribute('aria-label') || ''} ${i.name} ${i.id} ${(i.closest('label') || i.parentElement || {}).textContent || ''}`));
    return labelled || inputs.find((i) => i.type === 'number' || i.inputMode === 'numeric') || null;
  }

  function durationMinutes(text) {
    const t = simplify(text).replace(/\s+/g, '');
    let m = /^(\d+)(min|minute|minutes|mn)$/.exec(t);
    if (m) return Number(m[1]);
    m = /^(\d+)(h|heure|heures)$/.exec(t);
    return m ? Number(m[1]) * 60 : null;
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Ouvre le formulaire « Mettre aux enchères » s'il ne l'est pas encore
  // (en revenant d'abord sur « Détails » si besoin). Ne touche jamais à
  // « Lancer l'enchère ».
  async function openSellForm(view) {
    if (view.formOpen) return view;
    if (!findButton(SELL_TEXT, view.container)) {
      const detailsTab = findButton(DETAILS_TAB, view.container);
      if (detailsTab) {
        detailsTab.click();
        for (let i = 0; i < 20 && !findButton(SELL_TEXT, view.container); i++) await sleep(100);
      }
    }
    const sell = findButton(SELL_TEXT, view.container);
    if (!sell) return null;
    sell.click();
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      const now = cardView();
      if (now && now.formOpen) return now;
    }
    return null;
  }

  function fillForm(container, price, minutes) {
    const report = [];
    const input = priceInput(container);
    if (input) {
      setNativeValue(input, price);
      report.push(`prix ${price}`);
    } else {
      report.push('champ du prix introuvable');
    }
    const select = [...container.querySelectorAll('select')].find((s) => [...s.options].some((o) => durationMinutes(o.textContent) === minutes));
    if (select) {
      const option = [...select.options].find((o) => durationMinutes(o.textContent) === minutes);
      setNativeValue(select, option.value);
      report.push(`durée ${option.textContent.trim()}`);
    } else {
      const btn = [...container.querySelectorAll('button, [role="radio"], [role="tab"], label')]
        .find((b) => durationMinutes(b.textContent) === minutes && isVisible(b));
      if (btn && !FORBIDDEN.test(norm(btn.textContent))) {
        btn.click();
        report.push(`durée ${norm(btn.textContent)}`);
      } else {
        report.push('choix de la durée introuvable');
      }
    }
    log('Remplir :', report.join(', '));
    return report;
  }

  // ---------------------------------------------------------------------------
  // Encart
  // ---------------------------------------------------------------------------

  const fmtPrice = (p) => Math.round(p).toLocaleString('fr-FR');
  const fmtPct = (x) => `${Math.round(x * 100)} %`;
  const fmtDuration = (m) => (m < 60 ? `${m} min` : `${m / 60} h`);
  function fmtTime(ts) {
    const d = new Date(ts);
    const today = new Date();
    const tomorrow = new Date(Date.now() + DAY);
    const day = d.toDateString() === today.toDateString() ? 'aujourd’hui'
      : d.toDateString() === tomorrow.toDateString() ? 'demain'
        : d.toLocaleDateString('fr-FR', { weekday: 'long' });
    return `${day} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const panel = document.createElement('div');
  panel.id = 'wv-panel';
  const style = document.createElement('style');
  // Encart « téléphone » : bandeau sur toute la largeur, en bas (ou en haut,
  // réglable), réduit par défaut à une ligne qui donne l'essentiel ; un toucher
  // sur cette ligne affiche le détail (défilable, 55 % de l'écran au plus).
  style.textContent = `
    #wv-panel { --wv-bg: rgba(20,20,24,.96); --wv-line: rgba(255,255,255,.1); --wv-muted: #a1a1aa;
      position: fixed; left: 8px; right: 8px; bottom: calc(8px + env(safe-area-inset-bottom, 0px)); z-index: 2147483647;
      max-width: 560px; margin: 0 auto; font: 13px/1.3 system-ui, -apple-system, sans-serif; color: #f4f4f5;
      background: var(--wv-bg); border: 1px solid var(--wv-line); border-radius: 14px; box-shadow: 0 8px 28px rgba(0,0,0,.5);
      overflow: hidden; display: none; -webkit-tap-highlight-color: transparent; }
    #wv-panel.wv-top { bottom: auto; top: calc(8px + env(safe-area-inset-top, 0px)); }
    #wv-panel header { display: flex; align-items: center; gap: 6px; min-height: 40px; padding: 4px 12px; cursor: pointer;
      border-bottom: 1px solid var(--wv-line); }
    #wv-panel.wv-min header { border-bottom: 0; }
    #wv-panel header .wv-title { font-weight: 700; font-size: 13px; flex: 1; min-width: 0; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; }
    #wv-panel .wv-pill { font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 999px;
      background: rgba(255,255,255,.1); color: #e4e4e7; white-space: nowrap; }
    #wv-panel .wv-sum { font-size: 13px; font-weight: 700; white-space: nowrap; }
    #wv-panel .wv-sum i { font-style: normal; color: var(--wv-muted); font-weight: 500; }
    #wv-panel .wv-chevron { color: var(--wv-muted); font-size: 12px; width: 12px; text-align: right; }
    #wv-panel .wv-body { padding: 8px; display: grid; gap: 5px; max-height: 55vh; overflow-y: auto; overscroll-behavior: contain; }
    #wv-panel.wv-min .wv-body { display: none; }
    #wv-panel .wv-row { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px;
      padding: 6px 9px; border-radius: 10px; background: rgba(255,255,255,.05); border-left: 3px solid var(--wv-c); }
    #wv-panel .wv-label { font-size: 11px; font-weight: 600; color: var(--wv-c); }
    #wv-panel .wv-price { font-size: 17px; font-weight: 800; }
    #wv-panel .wv-price small { font-size: 11px; font-weight: 500; color: var(--wv-muted); margin-left: 4px; }
    #wv-panel .wv-when { font-size: 11px; color: #d4d4d8; }
    #wv-panel .wv-quick { --wv-c: #34d399; } #wv-panel .wv-normal { --wv-c: #fbbf24; } #wv-panel .wv-ambitious { --wv-c: #a78bfa; }
    #wv-panel .wv-bad { --wv-c: #f87171; } #wv-panel .wv-keep { --wv-c: #38bdf8; }
    #wv-panel button.wv-fill { background: var(--wv-c); color: #18181b; border: 0; border-radius: 9px; min-height: 36px;
      padding: 0 12px; font-weight: 700; font-size: 12px; }
    #wv-panel button.wv-fill:disabled { opacity: .3; }
    #wv-panel .wv-tip { font-size: 12px; color: #d4d4d8; padding: 5px 9px; border-radius: 9px; background: rgba(167,139,250,.1); }
    #wv-panel .wv-tip.wv-quick, #wv-panel .wv-tip.wv-keep, #wv-panel .wv-tip.wv-ambitious, #wv-panel .wv-tip.wv-bad {
      background: color-mix(in srgb, var(--wv-c) 16%, transparent); border-left: 3px solid var(--wv-c); font-weight: 600; }
    #wv-panel .wv-caps { display: grid; grid-template-columns: repeat(2, 1fr); gap: 5px; }
    #wv-panel .wr-row { padding: 6px 9px; border-radius: 10px; background: rgba(255,255,255,.05); border-left: 3px solid var(--wv-c, #a1a1aa); }
    #wv-panel .wr-lead { --wv-c: #4ade80; } #wv-panel .wr-behind { --wv-c: #fbbf24; } #wv-panel .wr-stop { --wv-c: #f87171; }
    #wv-panel .wr-over { --wv-c: #ef4444; background: rgba(239,68,68,.14); } #wv-panel .wr-over .wr-t, #wv-panel .wr-over .wr-s { color: #fca5a5; }
    #wv-panel .wr-t { font-weight: 700; display: flex; justify-content: space-between; gap: 6px; }
    #wv-panel .wr-s { font-size: 12px; color: #d4d4d8; margin-top: 2px; }
    #wv-panel .wr-modes { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-top: 6px; }
    #wv-panel .wr-modes button { border: 0; border-radius: 8px; min-height: 34px; font: inherit; font-size: 11px;
      background: rgba(255,255,255,.08); color: #e4e4e7; }
    #wv-panel .wr-modes button.on { background: #e4e4e7; color: #18181b; font-weight: 700; }
    #wv-panel .wv-cap { padding: 5px 7px; border-radius: 9px; background: rgba(255,255,255,.05); border-top: 3px solid var(--wv-c); }
    #wv-panel .wv-cap b { display: block; font-size: 15px; }
    #wv-panel .wv-cap span { font-size: 10px; color: var(--wv-muted); }
    #wv-panel .wv-status { font-size: 11px; color: var(--wv-muted); padding: 2px 4px; display: flex; gap: 8px; align-items: center; }
    #wv-panel .wv-spin { width: 12px; height: 12px; border: 2px solid rgba(255,255,255,.2); border-top-color: #fbbf24;
      border-radius: 50%; animation: wv-spin .8s linear infinite; }
    @keyframes wv-spin { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(style);
  document.body.appendChild(panel);
  // Réduit par défaut : une ligne avec l'essentiel.
  panel.classList.toggle('wv-min', GM_getValue(KEY_MINIMIZED, true));
  panel.classList.toggle('wv-top', GM_getValue(KEY_TOP, false));
  panel.addEventListener('click', (e) => {
    // Télécommande pas encore réglée : le bandeau lui-même demande le sujet.
    if (e.target.closest('header') && panel.dataset.mode === 'remote-setup') {
      remoteSetup();
      return;
    }
    if (e.target.closest('header')) {
      const min = !panel.classList.contains('wv-min');
      panel.classList.toggle('wv-min', min);
      GM_setValue(KEY_MINIMIZED, min);
      remote.touchedAt = 0; // redessin immédiat (flèche ▴ / ▾)
      render();
      return;
    }
    const rb = e.target.closest('button[data-rmode]');
    if (rb) {
      remoteChoose(rb.dataset.id, rb.dataset.rmode, rb.dataset.title);
      return;
    }
    const btn = e.target.closest('button.wv-fill');
    if (!btn || !state.view || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '…';
    openSellForm(state.view).then((view) => {
      if (!view) {
        btn.textContent = 'Échec';
        btn.title = 'Bouton « Mettre aux enchères » introuvable';
      } else {
        state.view = view;
        const report = fillForm(view.container, Number(btn.dataset.price), Number(btn.dataset.minutes));
        btn.textContent = 'Rempli ✓';
        btn.title = report.join(', ');
      }
      setTimeout(() => render(), 2500);
    });
  });

  const state = { key: null, view: null, card: null, advice: null, timing: null, status: '' };

  // Prix payé la dernière fois pour cette carte (achats lus dans les
  // notifications « Enchère gagnée ! » et les listes « Mes enchères »). Sobre,
  // à la demande de l'utilisateur : « Dernier achat : 1 045 » ; la rareté n'est
  // précisée que si l'achat connu est d'une autre rareté que la fiche.
  function purchaseLine() {
    const p = state.purchase;
    if (!p) return '';
    const other = p.rarity && state.rarity && p.rarity !== state.rarity ? ` (en ${esc(p.rarity)})` : '';
    return `<div class="wv-tip wv-keep">Dernier achat : ${fmtPrice(p.price)}${other}</div>`;
  }

  // Liste « Mes enchères » (celle que charge la page du marché) relue au plus
  // une fois toutes les 6 h, quand une fiche n'a aucun achat connu : les
  // achats plus anciens que les notifications y figurent (« won »).
  const KEY_MINE_READ = 'wv.mineReadAt';
  let mineReading = false;
  async function readMineList() {
    if (mineReading || Date.now() - GM_getValue(KEY_MINE_READ, 0) < 6 * 3600000) return;
    mineReading = true;
    GM_setValue(KEY_MINE_READ, Date.now());
    const url = '/api/marketplace?page=1&limit=50&sort=recent&mine=1';
    listUrls.set(`${location.origin}${url}`, Date.now()); // déjà lue : pas de relecture par l'aide à l'achat
    // Échec (refus, coupure, réponse illisible) : nouvel essai dans 30 min
    // (v1.4.0 ; avant, pas avant 6 h).
    const retrySoon = () => GM_setValue(KEY_MINE_READ, Date.now() - 6 * 3600000 + 30 * 60000);
    try {
      await gateWait('bulk', `${location.origin}${url}`);
      const res = await pageFetch(url);
      if (res.ok) {
        noteAuctions(await res.json());
        if (state.card) state.purchase = lastPurchase(state.card.id, state.rarity, state.shiny);
        render();
      } else {
        if (isRateRefusal(res.status, url)) gate.refused(res.status);
        retrySoon();
      }
    } catch (err) {
      log('Liste « Mes enchères » illisible', err.message);
      retrySoon();
    } finally {
      mineReading = false;
    }
  }

  const hhmm = (ts) => fmtTime(ts).replace(/^aujourd’hui à /, '');

  // Carte sans valeur : simple information (pas de bouton « Défausser » sur le
  // téléphone : geste irréversible, trop facile à toucher par erreur).
  const discardRow = (reason) => `<div class="wv-tip wv-bad">Ne vaut pas la vente : ${reason}</div>`;

  function render() {
    const { advice, timing, card, view } = state;
    if (!view) {
      if (buy) return renderBuy();
      if (remoteShown()) return renderRemote();
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'block';
    const title = card ? esc(card.data.wikipedia_title) : 'Aide à la vente';
    const count = advice && advice.enough ? `<span class="wv-count">${advice.n} ventes</span>` : '';
    const pill = state.rarity ? `<span class="wv-pill">${esc(state.rarity)}${state.shiny ? ' ✦' : ''}</span>` : '';
    let body = '';
    if (!advice) {
      body = `<div class="wv-status">${/Recherche/.test(state.status || 'Recherche') ? '<span class="wv-spin"></span>' : ''}${esc(state.status || 'Recherche des ventes…')}</div>`;
    } else if (!advice.enough) {
      body = `<div class="wv-status">Pas assez de ventes${state.rarity ? ` en rareté ${esc(state.rarity)}` : ''} pour conseiller un prix (${advice.n}).</div>`;
      if (state.shiny) body += `<div class="wv-tip">${esc(shinyNote(state.shinyVia, state.premium, advice.n))}</div>`;
      else body += discardRow('Trop peu de ventes pour la vendre');
    } else {
      const disabled = view.formOpen ? '' : 'title="Ouvre « Mettre aux enchères » et remplit le formulaire"';
      const row = (cls, label, price, share, opt) => `
        <div class="wv-row ${cls}"><div>
          <div class="wv-label">${label}</div>
          <div class="wv-price">${fmtPrice(price)}<small>${fmtPct(share)} des ventes</small></div>
          ${opt ? `<div class="wv-when">${fmtDuration(opt.minutes)} · fin ${hhmm(opt.end)}</div>` : ''}
        </div><button class="wv-fill" data-price="${price}" data-minutes="${opt ? opt.minutes : ''}" ${disabled}>Remplir</button></div>`;
      body += row('wv-quick', 'Vente rapide', advice.quick, advice.quickShare, timing && timing.quick);
      if (advice.normal !== advice.quick) body += row('wv-normal', 'Normal', advice.normal, advice.normalShare, timing && timing.normal);
      if (advice.ambitious) body += row('wv-ambitious', 'Ambitieux', advice.ambitious, advice.ambitiousShare, timing && timing.ambitious);
      if (state.shiny) body += `<div class="wv-tip">${esc(shinyNote(state.shinyVia, state.premium, advice.n))}</div>`;
      if (state.shiny) {
        // Jamais de défausse proposée pour une carte shiny.
      } else {
        const thin = isThin(state.sales7, state.span10);
        if (advice.normal < CONFIG.worthlessBelow) {
          body += discardRow(`« Normal » à ${fmtPrice(advice.normal)} : moins de ${CONFIG.worthlessBelow} wikibidous`);
        } else if (thin && advice.normal < CONFIG.thinWorthlessBelow) {
          body += discardRow(`💤 Se vend peu (${thinText(state.sales7, state.span10)}) pour ${fmtPrice(advice.normal)} wikibidous`);
        } else if (thin) {
          body += `<div class="wv-tip">💤 Se vend peu : ${esc(thinText(state.sales7, state.span10))}.</div>`;
        }
      }
      if (isHot(state.sales48)) body += `<div class="wv-tip">🔥 Se vend beaucoup : ${state.sales48} ventes en 48 h.</div>`;
      if (timing && timing.later) {
        body += `<div class="wv-tip">💡 Lancer ${fmtTime(timing.later.start)} avec ${fmtDuration(timing.later.minutes)} : fin ${hhmm(timing.later.end)}, environ +${fmtPrice(timing.later.gain)} wikibidous sur le prix « Normal »</div>`;
      }
    }
    body += purchaseLine();
    panel.dataset.mode = 'sale';
    // Ligne réduite : vente rapide et normale (ou l'état de la recherche).
    const summary = !advice ? '<i>…</i>'
      : !advice.enough ? '<i>trop peu de ventes</i>'
        : `${fmtPrice(advice.quick)}<i> rapide · </i>${fmtPrice(advice.normal)}<i> normal</i>`;
    panel.innerHTML = `<header><span class="wv-title">${title}</span>${pill}<span class="wv-sum">${summary}</span><span class="wv-chevron">${panel.classList.contains('wv-min') ? '▴' : '▾'}</span></header>`
      + `<div class="wv-body">${body}${count ? `<div class="wv-status">${count.replace(/<[^>]+>/g, '')} récentes${advice && advice.period ? ` (${esc(advice.period)})` : ''}</div>` : ''}</div>`;
  }

  // ---------------------------------------------------------------------------
  // Boucle
  // ---------------------------------------------------------------------------

  let busy = false;
  async function tick() {
    if (busy || document.hidden) return;
    const view = location.pathname.startsWith('/collection') ? cardView() : null;
    // Clé = titre + rareté : deux exemplaires d'une même carte de raretés
    // différentes n'ont pas les mêmes prix.
    const title = view ? cardTitles(view.container)[0] || '?' : null;
    const rarity = view ? cardRarity(view.container) : null;
    const shiny = view ? sheetShiny(view.container) : false;
    let key = view ? `${title}#${rarity || '?'}${shiny ? '✦' : ''}` : null;
    // Rareté momentanément illisible (animation) : même carte.
    if (view && !rarity && state.key && state.key.startsWith(`${title}#`) && state.key.endsWith('✦') === shiny) key = state.key;
    // Formulaire d'enchère : il concerne toujours la carte déjà reconnue.
    if (view && state.card && view.formOpen) key = state.key;
    const changed = key !== state.key;
    const formChanged = !!view && !!state.view && view.formOpen !== state.view.formOpen;
    state.view = view;
    if (!view) {
      state.key = null;
      render();
      return;
    }
    if (changed) {
      Object.assign(state, {
        key, card: null, advice: null, timing: null, computedAt: 0, error: null,
        rarity: cardRarity(view.container), shiny, openedAt: Date.now(), autoTried: false, discardMsg: '',
        status: 'Recherche des ventes…',
      });
      render();
    }
    if (!state.rarity) state.rarity = cardRarity(view.container);
    if (!state.card) {
      busy = true;
      try {
        state.card = await resolveCard(view, state.shiny);
      } finally {
        busy = false;
      }
      if (!state.card) {
        const gaveUp = (state.autoTried || !autoOpenAllowed()) && Date.now() - state.openedAt > CONFIG.autoOpenDelayMs + 6000;
        state.status = state.error
          || (gaveUp ? 'Ventes introuvables pour cette carte : ouvre l’onglet « Marché » une fois (la carte sera ensuite retenue).' : 'Recherche des ventes…');
        render();
        return;
      }
      log('Carte reconnue :', state.card.data.wikipedia_title, state.rarity);
    }
    if (!state.computedAt || formChanged || Date.now() - state.computedAt > 60000) {
      const now = Date.now();
      const sales = state.card.data.sales || [];
      const adv = state.shiny ? shinyAdvice(sales, state.rarity) : adviceFor(sales, state.rarity);
      Object.assign(state, { advice: adv.price, sales7: adv.sales7, sales48: adv.sales48, span10: adv.span10, shinyVia: adv.via || null, premium: adv.premium || null });
      state.purchase = lastPurchase(state.card.id, state.rarity, state.shiny);
      if (!state.purchase) readMineList();
      const profile = currentProfile(now);
      state.profileUsed = profile.used;
      state.profileCards = profile.cards;
      state.timing = state.advice.enough ? durationAdvice(profile, state.rarity, now, state.advice) : null;
      state.computedAt = now;
      render();
    }
  }
  // Réaction immédiate aux changements de la page (ouverture d'une fiche), avec
  // une vérification régulière en filet de sécurité.
  let queued = false;
  // Onglet caché : rien, sauf pendant un nettoyage (lectures des valeurs).
  const runTick = () => {
    queued = false;
    tick().catch((err) => console.error('[WV]', err));
    if (!document.hidden || clean.running) {
      if (!document.hidden) buyTick().catch((err) => console.error('[WV]', err));
      try {
        collectionTick();
        if (!document.hidden) {
          marketTick();
          remoteTick();
        }
      } catch (err) {
        console.error('[WV]', err);
      }
    }
  };
  // Minuteries du worker seulement quand il le faut (onglet visible ou
  // nettoyage en cours) : un onglet caché inactif reste au ralenti.
  const timer = (fn, ms) => (document.hidden && !clean.running ? setTimeout(fn, ms) : later(fn, ms));
  const schedule = () => {
    if (queued) return;
    queued = true;
    timer(runTick, 60);
  };
  new MutationObserver((mutations) => {
    if (mutations.some((m) => !panel.contains(m.target) && !badgeLayer.contains(m.target))) schedule();
  }).observe(document.body, { childList: true, subtree: true });
  const beat = () => {
    schedule();
    timer(beat, 700);
  };
  setTimeout(beat, 700);

  // ---------------------------------------------------------------------------
  // Aide à l'achat : une pastille sur chaque enchère de /marketplace
  // ---------------------------------------------------------------------------

  // Enchères lues dans les listes de la page : identifiant → carte, rareté, prix.
  const auctions = new Map();
  let listStatus = '—';
  function noteAuctions(data) {
    const pairs = [];
    for (const key of ['auctions', 'bidding', 'selling', 'won', 'history']) {
      for (const a of (data && data[key]) || []) {
        if (!a || !a.id || !a.card_id) continue;
        const shiny = a.is_shiny === true;
        auctions.set(a.id.toLowerCase(), {
          cardId: a.card_id,
          rarity: a.snapshot_rarity || (a.card && a.card.rarity) || null,
          shiny,
          current: a.current_bid,
          end: Date.parse(a.end_at),
        });
        noteAuctionFacts(a, key === 'won');
        // Titre d'une carte shiny rangé à part : si le site donnait un autre
        // identifiant aux cartes shiny, il ne remplacerait pas celui de la carte normale.
        if (a.card && a.card.wikipedia_title) pairs.push([shiny ? `${a.card.wikipedia_title} ✦` : a.card.wikipedia_title, a.card_id]);
      }
    }
    rememberIds(pairs);
    if (data && Array.isArray(data.bidding)) noteFollowed(data);
  }

  // Faits durables tirés d'une enchère : enchère shiny (pour reconnaître sa
  // vente plus tard), enchère vendue (contrôle ventes ↔ enchères), achat.
  function noteAuctionFacts(a, won) {
    const id = String(a.id).toLowerCase();
    if (a.is_shiny === true && !shinyAuctions[id]) {
      shinyAuctions[id] = [a.card_id, a.snapshot_rarity || null, Math.round(Date.parse(a.end_at) / 1000) || 0];
      touch(KEY_SHINY_AUCTIONS);
    }
    const sold = a.status === 'settled_sold' && Number(a.final_price) > 0;
    if (sold && !joinCheck[id]) {
      joinCheck[id] = [a.card_id, Number(a.final_price), null];
      touch(KEY_JOIN);
    }
    if (sold && won && (!bought[id] || bought[id][3] == null)) {
      bought[id] = [a.card_id, Number(a.final_price), Math.round(Date.parse(a.settled_at || a.end_at) / 1000),
        a.snapshot_rarity || null, a.is_shiny === true, (a.card && a.card.wikipedia_title) || null];
      touch(KEY_BOUGHT);
    }
  }

  // Notifications que la page charge elle-même (cloche) : achats (« Enchère
  // gagnée ! ») et ventes (« Carte vendue ! »), avec l'enchère et le prix.
  function noteNotifications(json) {
    for (const n of (json && json.notifications) || []) {
      const d = n && n.data;
      if (!d || !d.auction_id || !d.card_id || !(Number(d.final_price) > 0)) continue;
      const id = String(d.auction_id).toLowerCase();
      const price = Number(d.final_price);
      if (n.type === 'marketplace_auction_won' && !bought[id]) {
        const a = auctions.get(id);
        bought[id] = [d.card_id, price, Math.round(Date.parse(n.created_at) / 1000) || 0, a ? a.rarity : null, a ? a.shiny : null, d.card_title || null];
        touch(KEY_BOUGHT);
      }
      if (/^marketplace_auction_(sold|won)$/.test(n.type) && !joinCheck[id]) {
        joinCheck[id] = [d.card_id, price, null];
        touch(KEY_JOIN);
      }
    }
  }

  // Dernier achat connu d'une carte : de préférence même rareté et même
  // version (normale ou shiny) ; sinon un achat de la même carte, rareté indiquée.
  function lastPurchase(cardId, rarity, shiny) {
    let best = null;
    for (const e of Object.values(bought)) {
      if (e[0] !== cardId) continue;
      const score = (e[3] === rarity ? 2 : e[3] == null ? 1 : 0) + (e[4] == null || e[4] === shiny ? 1 : 0);
      if (!best || score > best.score || (score === best.score && e[2] > best.at / 1000)) {
        best = { score, price: e[1], at: e[2] * 1000, rarity: e[3], shiny: e[4] };
      }
    }
    return best;
  }

  // Relit une fois chaque liste chargée par la page (même requête, même session).
  let readingLists = false;
  async function readLists() {
    if (readingLists) return;
    const url = [...listUrls].find(([, at]) => !at);
    if (!url) return;
    readingLists = true;
    listUrls.set(url[0], Date.now());
    try {
      await gateWait('urgent', url[0]);
      const res = await pageFetch(url[0]);
      listStatus = `${url[0].replace(location.origin, '')} → ${res.status}`;
      if (res.ok) noteAuctions(await res.json());
    } catch (err) {
      listStatus = `${url[0]} → ${err.message}`;
    } finally {
      readingLists = false;
    }
  }

  // Pastille de rareté (relevé réel) : « SR », ou « L✦ shiny » pour une carte
  // shiny (div.shiny-badge : « L », une étoile ✦, et « shiny » pour les lecteurs d'écran).
  function badgeRarity(badge) {
    const code = norm(badge.textContent).replace(/✦.*$/, '').replace(/shiny/i, '').trim();
    return RARITIES.includes(code) ? code : null;
  }
  const isShinyEl = (root) => !!root.querySelector('.shiny-badge')
    || [...root.querySelectorAll('.sr-only')].some((e) => /\bshiny\b/i.test(e.textContent));

  // Lecture d'une enchère affichée (relevé réel) : titre en h3, rareté dans la
  // pastille colorée (« SR »), prix dans le span couleur d'accent, précédé de
  // son libellé (« Mise de départ »).
  const PRICE_LABEL = /^(mise de d[ée]part|(mise|ench[èe]re|offre) actuelle|prix actuel|derni[èe]re (mise|ench[èe]re|offre)|meilleure (mise|ench[èe]re|offre))$/i;
  function listingInfo(el, ids) {
    const id = el.id.slice('marketplace-auction-'.length).toLowerCase();
    const api = auctions.get(id) || null;
    const title = norm((el.querySelector('h3') || {}).textContent);
    const badge = el.querySelector('.shiny-badge') || el.querySelector('[style*="--color-rarity-"]');
    let rarity = badge ? badgeRarity(badge) : null;
    if (!rarity && api) rarity = api.rarity;
    const shiny = (api && api.shiny) || isShinyEl(el);
    let price = null;
    let label = null;
    const accent = [...el.querySelectorAll('span')]
      .find((n) => n.className.includes('text-[var(--color-accent)]') && /\d/.test(n.textContent));
    if (accent) {
      price = Number(accent.textContent.replace(/\D/g, ''));
      label = norm((accent.previousElementSibling || {}).textContent) || null;
    } else {
      for (const node of el.querySelectorAll('span, div, p')) {
        if (node.children.length || !PRICE_LABEL.test(norm(node.textContent)) || !node.nextElementSibling) continue;
        const digits = node.nextElementSibling.textContent.replace(/\D/g, '');
        if (digits) {
          price = Number(digits);
          label = norm(node.textContent);
          break;
        }
      }
    }
    if (price === null && api && api.current != null) price = api.current;
    const hasBid = label ? !/d[ée]part/i.test(label) : !!(api && api.current != null);
    const cardId = (api && api.cardId) || (title && ((shiny && ids[simplify(`${title} ✦`)]) || ids[simplify(title)])) || null;
    // Ce qu'il faut miser au minimum : la mise de départ, ou +10 % s'il y a déjà une mise.
    const pay = price === null ? null : hasBid ? nextBid(price) : price;
    return { id, title, rarity, shiny, price, hasBid, pay, cardId };
  }
  // Prochaine mise minimale : mise × (1 + bidStep), arrondie au-dessus, calculée
  // en centièmes entiers (v1.4.0 : en virgule flottante, 100 × 1,1 donnait 111).
  function nextBid(current) {
    return Math.ceil((current * Math.round((1 + CONFIG.buy.bidStep) * 100)) / 100);
  }

  const badgeLayer = document.createElement('div');
  badgeLayer.id = 'wv-badges';
  const badgeStyle = document.createElement('style');
  badgeStyle.textContent = `
    #wv-badges { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
    #wv-badges .wv-b { position: absolute; transform: translateX(-50%); pointer-events: none;
      font: 700 11px/1 system-ui, sans-serif; padding: 4px 7px; border-radius: 999px; white-space: nowrap;
      color: #0b0b0e; background: var(--wv-c); box-shadow: 0 2px 8px rgba(0,0,0,.45); }
    #wv-badges .wv-b { --wv-c: #a1a1aa; font-size: 10px; padding: 2px 5px; }
    #wv-badges .wv-v { cursor: help; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.45); }
  `;
  document.head.appendChild(badgeStyle);
  document.body.appendChild(badgeLayer);

  const badges = new Map(); // identifiant d'enchère → { el, target }
  const cardBadges = new Map(); // carte de la collection (élément) → { el, target }
  const inFlight = new Set(); // cartes en cours de lecture
  const failedAt = new Map(); // carte → échec de lecture (nouvel essai 1 min après)
  const between = (a, b) => a + Math.random() * (b - a);

  // Couleur d'un écart à la médiane : vert (−80 % et moins), jaune (0),
  // rouge (+80 % et plus), en passant par la roue des teintes.
  function deltaColor(delta) {
    const t = Math.max(-1, Math.min(1, delta / CONFIG.buy.colorSpan));
    const hue = t < 0 ? 50 + -t * (135 - 50) : 50 - t * 50;
    return `hsl(${Math.round(hue)}, 90%, ${t < 0 ? 48 : 55}%)`;
  }
  const fmtDelta = (delta) => `${delta >= 0 ? '+' : '-'}${Math.abs(Math.round(delta * 100))}%`;

  // Ligne d'explication pour une carte shiny (pastilles, encarts).
  function shinyNote(via, premium, n) {
    if (via === 'ventes') return `✦ Shiny : estimée sur ses propres ventes shiny (${n}).`;
    if (via === 'prime') return `✦ Shiny : valeur d’une carte normale × ${(1 + premium.beta).toFixed(2).replace('.', ',')}, prime ${fmtPremium(premium)}.`;
    return '✦ Shiny : prime pas encore mesurée (trop peu de ventes shiny connues) → valeurs d’une carte normale, sans doute trop basses.';
  }

  function badgeContent(info, sum) {
    if (!info.cardId) return { bg: null, text: '?', tip: listUrls.size ? 'Carte non reconnue : absente des listes chargées par la page.' : 'Carte non reconnue : la liste du marché n’a pas encore été lue.' };
    if (!sum) return { bg: null, text: '…', tip: 'Lecture des ventes…' };
    const star = info.shiny ? '✦' : '';
    const head = `${info.title || 'Carte'}${info.rarity ? ` (${info.rarity}${info.shiny ? ' ✦ shiny' : ''})` : ''}`;
    if (sum.median === null) return { bg: null, text: `${star}${sum.n} v.`, tip: `${head} : trop peu de ventes pour comparer (${sum.n}).` };
    if (info.pay === null) return { bg: null, text: '—', tip: `${head} : prix illisible.` };
    // 0 % = prix de vente rapide estimé (réglable dans le menu).
    const ref = refOf(sum);
    const delta = info.pay / ref.price - 1;
    const collection = !!collectionMem[info.cardId];
    const unsure = info.shiny && sum.shinyVia === 'inconnue';
    const caps = sum.resaleCap === null
      ? `Plafond revente : il faut au moins ${CONFIG.buy.minSales} ventes.`
      : `Plafond revente : ${fmtPrice(sum.resaleCap)} (revente estimée ${fmtPrice(sum.resale)})`;
    return {
      bg: deltaColor(delta),
      text: `${collection ? '★ ' : ''}${star}${isHot(sum.sales48) ? '🔥' : ''}${fmtDelta(delta)}${unsure ? ' ?' : ''}`,
      tip: `${head} — ${sum.n} ventes récentes${sum.stale ? ' (valeur ancienne, relecture en cours)' : ''}\n`
        + (info.shiny ? `${shinyNote(sum.shinyVia, sum.premium, sum.n)}\n` : '')
        + `${info.hasBid ? 'Prochaine mise ≈' : 'Mise de départ :'} ${fmtPrice(info.pay)}, ${ref.name} ${fmtPrice(ref.price)} → ${fmtDelta(delta)}\n`
        + `Vente rapide ${sum.quick != null ? fmtPrice(sum.quick) : '—'} · normale ${sum.normal != null ? fmtPrice(sum.normal) : '—'} · médiane ${fmtPrice(sum.median)}\n${caps}\n`
        + (isHot(sum.sales48) ? `🔥 Se vend beaucoup : ${sum.sales48} ventes en 48 h\n` : '')
        + (collection
          ? `★ Carte de collection : plafond = médiane. Clic : retirer de la collection.`
          : `Clic : marquer comme carte de collection (plafond = médiane).`)
        + '\nDétail complet : ouvre l’enchère.',
    };
  }

  function placeBadges() {
    placeIn(badges);
    placeIn(cardBadges);
  }
  function placeIn(map) {
    for (const [id, b] of map) {
      if (!b.target.isConnected) {
        b.el.remove();
        map.delete(id);
        continue;
      }
      const r = b.target.getBoundingClientRect();
      const out = r.width < 2 || r.bottom < 0 || r.top > innerHeight;
      b.el.style.display = out ? 'none' : '';
      if (out) continue;
      b.el.style.left = `${Math.round(r.left + r.width / 2)}px`;
      b.el.style.top = `${Math.round(r.top + 6)}px`;
    }
  }
  let placeQueued = false;
  addEventListener('scroll', () => {
    if (placeQueued) return;
    placeQueued = true;
    requestAnimationFrame(() => {
      placeQueued = false;
      placeBadges();
    });
  }, { capture: true, passive: true });
  addEventListener('resize', () => placeBadges(), { passive: true });

  function marketTick() {
    const onMarket = location.pathname.startsWith('/marketplace');
    if (!onMarket) {
      if (badges.size) {
        badges.forEach((b) => b.el.remove());
        badges.clear();
      }
      return;
    }
    readLists();
    const seen = new Set();
    const visible = [];
    const later = [];
    const refresh = [];
    const ids = idsMem;
    for (const el of document.querySelectorAll('[id^="marketplace-auction-"]')) {
      const target = el.querySelector('.card-frame') || el;
      const r = target.getBoundingClientRect();
      if (r.width < 2) continue;
      const info = listingInfo(el, ids);
      const sum = info.cardId ? valueFor(info.cardId, info.rarity, info.shiny) : null;
      // Toutes les cartes de la page sont lues : les inconnues à l'écran, les
      // autres inconnues, puis les résumés anciens (ou d'avant la v0.12, sans
      // prix « Vente rapide ») à rafraîchir.
      if (info.cardId && !sum) (r.bottom > -100 && r.top < innerHeight + 100 ? visible : later).push(info.cardId);
      else if (sum && (sum.stale || ((sum.quick == null || sum.sales48 === undefined) && sum.median !== null))) refresh.push(info.cardId);
      seen.add(info.id);
      const content = badgeContent(info, sum);
      let b = badges.get(info.id);
      if (!b) {
        b = { el: document.createElement('span'), target };
        badgeLayer.appendChild(b.el);
        badges.set(info.id, b);
      }
      b.target = target;
      b.el.className = 'wv-b';
      b.el.style.setProperty('--wv-c', content.bg || '#a1a1aa');
      b.el.style.opacity = sum && sum.stale ? '.7' : '';
      if (b.el.textContent !== content.text) b.el.textContent = content.text;
      b.el.title = content.tip;
      b.el.dataset.card = info.cardId || '';
    }
    for (const [id, b] of badges) {
      if (!seen.has(id)) {
        b.el.remove();
        badges.delete(id);
      }
    }
    placeBadges();
    pumpSales([...new Set([...visible, ...later, ...refresh, ...shinyFollowUps()])]);
  }

  // Enchères shiny terminées depuis plus de 3 min (et moins de 3 jours) : la
  // carte est relue une fois pour trouver le prix final de la vente shiny.
  // Quelques lectures par jour au plus.
  function shinyFollowUps() {
    const now = Date.now() / 1000;
    const ids = new Set();
    for (const e of Object.values(shinyAuctions)) {
      if (!e[3] && e[2] && now > e[2] + 180 && now < e[2] + 3 * 86400) ids.add(e[0]);
      if (ids.size >= 5) break;
    }
    return [...ids];
  }
  // Après une vraie lecture des ventes d'une carte : ses enchères shiny
  // terminées sont vérifiées (vente trouvée ou non).
  function markShinyChecked(cardId) {
    const now = Date.now() / 1000;
    let changed = false;
    for (const e of Object.values(shinyAuctions)) {
      if (e[0] === cardId && !e[3] && e[2] && now > e[2] + 180) {
        e[3] = Math.round(now);
        changed = true;
      }
    }
    if (changed) touch(KEY_SHINY_AUCTIONS);
  }

  // ---------------------------------------------------------------------------
  // Collection : prix « Normal » estimé sur chaque carte de la grille
  // ---------------------------------------------------------------------------

  // Rouge si sans valeur (à défausser), puis du bleu (worthlessBelow) au vert
  // franc (valueGreen et au-delà).
  function valueColor(price, thin = false) {
    if (worthless(price, thin)) return 'hsl(0, 85%, 55%)';
    const t = Math.min(1, Math.max(0, (price - CONFIG.worthlessBelow) / (CONFIG.valueGreen - CONFIG.worthlessBelow)));
    return `hsl(${Math.round(215 - t * 80)}, ${Math.round(70 + t * 25)}%, ${Math.round(55 - t * 10)}%)`;
  }

  // Cartes de la grille (relevé réel) : div.rounded-2xl.overflow-hidden, classe
  // glow-<rareté>, pastille de rareté en haut à gauche, titre en h3.
  const GLOW = /\bglow-(l|ur|sr|r|pc|c)\b/i;
  function gridCards() {
    const out = [];
    for (const face of document.querySelectorAll('div.rounded-2xl.overflow-hidden')) {
      const h3 = face.querySelector('h3');
      if (!h3 || face.closest('.fixed, [role="dialog"], [id^="marketplace-auction-"]') || panel.contains(face)) continue;
      let rarity = (GLOW.exec(face.className) || [])[1];
      rarity = rarity ? rarity.toUpperCase() : null;
      const shinyBadge = face.querySelector('.shiny-badge');
      if (!rarity && shinyBadge) rarity = badgeRarity(shinyBadge);
      if (!rarity) {
        for (const d of face.querySelectorAll('div, span')) {
          if (!d.children.length && RARITIES.includes(norm(d.textContent))) {
            rarity = norm(d.textContent);
            break;
          }
        }
      }
      out.push({ face, title: norm(h3.textContent), rarity, shiny: !!shinyBadge || isShinyEl(face) });
    }
    return out;
  }

  // Profil d'un joueur (/profile/<pseudo>) : mêmes pastilles que la
  // collection, mais avec le prix de vente rapide, pour estimer ses cartes.
  const onProfile = () => /^\/profile(\/|$)/.test(location.pathname);

  function collectionTick() {
    // Fiche d'une carte ouverte par-dessus la grille : pastilles masquées.
    badgeLayer.style.display = state.view ? 'none' : '';
    const profile = onProfile();
    if (!location.pathname.startsWith('/collection') && !profile) {
      if (cardBadges.size) {
        cardBadges.forEach((b) => b.el.remove());
        cardBadges.clear();
      }
      return;
    }
    const ids = idsMem;
    const seen = new Set();
    const visible = [];
    const later = [];
    const refresh = [];
    for (const { face, title, rarity, shiny } of gridCards()) {
      const r = face.getBoundingClientRect();
      if (r.width < 2) continue;
      // Profil : seulement les vraies cartes (rareté lisible), pas les
      // autres encadrés de la page.
      if (profile && !rarity) continue;
      seen.add(face);
      const cardId = gridCardId(title, shiny, ids);
      const sum = cardId ? valueFor(cardId, rarity, shiny, CONFIG.collectionSummaryHours) : null;
      if (cardId && !sum) (r.bottom > -100 && r.top < innerHeight + 100 ? visible : later).push(cardId);
      // Résumé ancien, ou d'avant la v0.14 (sans l'écart des 10 dernières ventes) : relu.
      else if (sum && (sum.stale || ((sum.span10 === undefined || sum.sales48 === undefined) && sum.median !== null))) refresh.push(cardId);
      let text;
      let bg;
      let tip;
      const head = `${title}${rarity ? ` (${rarity}${shiny ? ' ✦ shiny' : ''})` : ''}`;
      if (!cardId) {
        [text, bg, tip] = ['?', null, profile
          ? `${head} : carte pas encore reconnue. Elle le sera dès que tu la croiseras sur le marché ou dans ta collection.`
          : `${head} : carte pas encore reconnue. Elle le sera en ouvrant sa fiche une fois.`];
      } else if (!sum) {
        [text, bg, tip] = ['…', null, `${head} : lecture des ventes…`];
      } else if (sum.normal === null) {
        [text, bg, tip] = ['–', valueColor(null), `${head} : trop peu de ventes (${sum.n}) pour estimer un prix${profile ? '.' : ' → à défausser.'}`];
      } else if (profile) {
        const thin = isThin(sum.sales7, sum.span10);
        const quick = sum.quick != null ? sum.quick : sum.normal;
        text = `${thin ? '💤 ' : isHot(sum.sales48) ? '🔥 ' : ''}${fmtPrice(quick)}`;
        bg = valueColor(quick, thin);
        tip = `${head} : vente rapide estimée à ${fmtPrice(quick)} wikibidous · normale ${fmtPrice(sum.normal)}`
          + `${sum.median != null ? ` · médiane ${fmtPrice(sum.median)}` : ''} (${thinText(sum.sales7, sum.span10)})`
          + (thin ? '. 💤 Se vend peu.' : isHot(sum.sales48) ? `. 🔥 Se vend beaucoup (${sum.sales48} ventes en 48 h).` : '.');
      } else {
        const thin = isThin(sum.sales7, sum.span10);
        text = `${thin ? '💤 ' : isHot(sum.sales48) ? '🔥 ' : ''}${fmtPrice(sum.normal)}`;
        bg = valueColor(sum.normal, thin);
        tip = `${head} : vente « Normal » estimée à ${fmtPrice(sum.normal)} wikibidous (${thinText(sum.sales7, sum.span10)})`
          + (thin ? '. 💤 Se vend peu.' : isHot(sum.sales48) ? `. 🔥 Se vend beaucoup (${sum.sales48} ventes en 48 h).` : '.')
          + (worthless(sum.normal, thin) ? ' → sans valeur, à défausser.' : '');
      }
      let b = cardBadges.get(face);
      if (!b) {
        b = { el: document.createElement('span'), target: face };
        b.el.className = 'wv-b wv-v';
        b.el.__face = face;
        badgeLayer.appendChild(b.el);
        cardBadges.set(face, b);
      }
      // Carte shiny : étoile, explication, et jamais le rouge « à défausser »
      // tant que la prime n'est pas mesurée.
      if (shiny && sum && cardId) {
        text = `✦ ${text}`;
        tip = `${tip}\n${shinyNote(sum.shinyVia, sum.premium, sum.n)}`.replace(' → à défausser.', '.');
        if (sum.shinyVia === 'inconnue' || (bg === valueColor(null))) bg = '#a78bfa';
      }
      b.el.style.setProperty('--wv-c', bg || '#a1a1aa');
      b.el.style.opacity = sum && sum.stale ? '.7' : '';
      if (b.el.textContent !== text) b.el.textContent = text;
      b.el.title = tip;
    }
    for (const [face, b] of cardBadges) {
      if (!seen.has(face)) {
        b.el.remove();
        cardBadges.delete(face);
      }
    }
    placeIn(cardBadges);
    pumpSales([...new Set([...visible, ...later, ...refresh, ...shinyFollowUps()])]);
  }
  // Identifiant d'une carte de la grille : titre shiny d'abord pour une carte shiny.
  const gridCardId = (title, shiny, ids = idsMem) => (shiny && ids[simplify(`${title} ✦`)]) || ids[simplify(title)] || null;

  // Lectures en parallèle (3 au plus), relancées dès qu'une se termine, au
  // rythme permis par le portier de débit : aucune ne part si elle risque
  // d'être refusée. Départs espacés de 40 à 160 ms, jamais en rafale. Une carte
  // refusée n'est pas pénalisée (elle repart après la pause) ; autre échec :
  // nouvel essai après 5, 10, 20… s (60 s au plus).
  const failCount = new Map();
  let lastQueue = [];
  let nextStartAt = 0;
  let pumpTimer = false;
  function pumpLater(ms) {
    if (pumpTimer) return;
    pumpTimer = true;
    timer(() => {
      pumpTimer = false;
      pumpSales(lastQueue);
    }, ms);
  }
  function pumpSales(queue) {
    lastQueue = queue;
    const now = Date.now();
    const retryIn = (id) => Math.min(60000, 5000 * 2 ** ((failCount.get(id) || 1) - 1));
    for (const next of queue) {
      if (inFlight.size >= CONFIG.buy.parallel) break;
      if (inFlight.has(next) || deadIds.has(next) || now - (failedAt.get(next) || 0) < retryIn(next)) continue;
      const cached = salesCache.get(next);
      const fresh = cached && Date.now() - cached.at < CONFIG.buy.cacheMinutes * 60000;
      const wait = Math.max(nextStartAt - Date.now(), fresh ? 0 : gate.delay('bulk'));
      if (wait > 0) {
        pumpLater(wait + 5);
        break;
      }
      nextStartAt = Date.now() + between(40, 160);
      inFlight.add(next);
      readStats.inflightMax = Math.max(readStats.inflightMax, inFlight.size);
      fetchSales(next, CONFIG.buy.cacheMinutes * 60000, 'bulk')
        .then((data) => {
          failCount.delete(next);
          const e = summaries[next];
          if (!e || Date.now() - e.at > 60000 || !e.t) summarize(next, data.sales || [], data.wikipedia_title);
        })
        .catch((err) => {
          log('Ventes illisibles', next, err.message);
          if (!isRateRefusal(err.status, '/api/marketplace')) {
            failedAt.set(next, Date.now());
            failCount.set(next, (failCount.get(next) || 0) + 1);
            // Carte introuvable (404) trois fois de suite : identifiant sans
            // doute mal associé à ce titre. Plus relue pendant cette session, et
            // l'association est oubliée (v1.4.0).
            if (err.status === 404 && failCount.get(next) >= 3) forgetId(next);
          }
        })
        .finally(() => {
          inFlight.delete(next);
          schedule();
          pumpSales(lastQueue.filter((id) => id !== next));
        });
    }
  }

  // ---------------------------------------------------------------------------
  // Page d'une enchère (/marketplace/<id>) : conseil d'achat détaillé
  // ---------------------------------------------------------------------------

  const AUCTION_PATH = new RegExp(`^/marketplace/${UUID}/?$`, 'i');
  let buy = null; // { id, auction, sales, advice, status, readAt, apiOk }

  // Cherche l'enchère dans une réponse JSON, quelle que soit sa forme.
  function findAuctionObject(obj, id, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 4) return null;
    if (!Array.isArray(obj) && obj.card_id && (!obj.id || String(obj.id).toLowerCase() === id)) return obj;
    for (const v of Object.values(obj)) {
      const hit = findAuctionObject(v, id, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const auctionFromApi = (a) => ({
    cardId: a.card_id,
    rarity: a.snapshot_rarity || (a.card && a.card.rarity) || null,
    shiny: a.is_shiny === true,
    base: a.base_amount,
    current: a.current_bid,
    end: Date.parse(a.end_at),
    title: a.card && a.card.wikipedia_title,
    leader: a.current_bidder && a.current_bidder.username,
  });

  // Titre, rareté et prix lus sur la page, en dernier recours.
  function auctionFromPage() {
    const root = document.querySelector('main') || document.body;
    const title = [...root.querySelectorAll('h1, h2, h3')].filter((h) => !panel.contains(h) && isVisible(h))
      .map((h) => norm(h.textContent)).find((t) => t && !/^(march[ée]|ench[èe]res?)$/i.test(t)) || null;
    let rarity = null;
    for (const el of root.querySelectorAll('span, div')) {
      if (el.children.length || el.textContent.length > 14 || panel.contains(el)) continue;
      const code = rarityCode(el.textContent);
      if (code && isVisible(el)) {
        rarity = code;
        break;
      }
    }
    return { title, rarity };
  }

  // Montant proposé par le site à côté du bouton « Miser » : la mise minimale.
  function pageMinBid() {
    const btn = [...document.querySelectorAll('button')].find((b) => /^miser$/i.test(norm(b.textContent)) && isVisible(b));
    for (let n = btn && btn.parentElement, d = 0; n && d < 4; n = n.parentElement, d++) {
      const input = [...n.querySelectorAll('input')].find((i) => isVisible(i) && i.value);
      if (input) return Number(String(input.value).replace(/\D/g, '')) || null;
    }
    return null;
  }

  async function readAuction(id) {
    await gateWait('urgent', `${location.origin}/api/marketplace/${id}`);
    const res = await pageFetch(`/api/marketplace/${id}`);
    if (!res.ok) {
      if (isRateRefusal(res.status, '/api/marketplace')) gate.refused(res.status);
      throw new Error(`HTTP ${res.status}`);
    }
    const found = findAuctionObject(await res.json(), id);
    if (!found) throw new Error('enchère absente de la réponse');
    noteAuctionFacts(found, false);
    const a = auctionFromApi(found);
    auctions.set(id, a);
    if (a.title) rememberIds([[a.title, a.cardId]]);
    return a;
  }

  let buyBusy = false;
  async function buyTick() {
    const m = AUCTION_PATH.exec(location.pathname);
    if (!m) {
      if (buy) {
        buy = null;
        render();
      }
      return;
    }
    const id = m[1].toLowerCase();
    if (!buy || buy.id !== id) {
      buy = { id, auction: auctions.get(id) || null, sales: null, status: 'Recherche de la carte…', readAt: 0, apiOk: null };
      render();
    }
    if (buyBusy) return;
    buyBusy = true;
    try {
      // Enchère : l'API (relue toutes les 20 s), sinon la liste déjà lue, sinon la page.
      if (buy.apiOk !== false && Date.now() - buy.readAt > 20000) {
        buy.readAt = Date.now();
        try {
          buy.auction = await readAuction(id);
          buy.apiOk = true;
        } catch (err) {
          log('Lecture de l’enchère impossible', err.message);
          if (buy.apiOk === null) buy.apiOk = false;
        }
      }
      if (!buy.auction) {
        // Page ouverte directement : carte retrouvée par son titre (mémoire), ou
        // par les ventes que la page a elle-même chargées.
        const page = auctionFromPage();
        let cardId = (page.title && knownId(page.title)) || null;
        for (const seen of seenIds.slice(0, 3)) {
          if (cardId || !page.title) break;
          const data = await fetchSales(seen, CONFIG.buy.cacheMinutes * 60000).catch(() => null);
          if (data && simplify(data.wikipedia_title) === simplify(page.title)) cardId = seen;
        }
        if (cardId) buy.auction = { cardId, rarity: page.rarity, shiny: isShinyEl(document.querySelector('main') || document.body), title: page.title, base: null, current: null };
      }
      if (!buy.auction) {
        buy.status = 'Carte non reconnue : passe d’abord par la liste du marché.';
        return;
      }
      if (!buy.sales) {
        const data = await fetchSales(buy.auction.cardId, CONFIG.buy.cacheMinutes * 60000);
        buy.sales = data.sales || [];
        buy.title = buy.auction.title || data.wikipedia_title;
      }
      const adv = buy.auction.shiny ? shinyAdvice(buy.sales, buy.auction.rarity) : adviceFor(buy.sales, buy.auction.rarity);
      Object.assign(buy, { advice: adv.buy, price: adv.price, via: adv.via || null, premium: adv.premium || null, status: '' });
    } catch (err) {
      buy.status = `Erreur : ${err.message}`;
    } finally {
      buyBusy = false;
      render();
    }
  }

  let lastBuyHtml = '';
  function renderBuy() {
    const a = buy.auction;
    const adv = buy.advice;
    const title = esc(buy.title || (a && a.title) || 'Aide à l’achat');
    const pill = a && a.rarity ? `<span class="wv-pill">${esc(a.rarity)}${a.shiny ? ' ✦' : ''}</span>` : '';
    const count = adv && adv.enough ? `<span class="wv-count">${adv.n} ventes</span>` : '';
    let body = '';
    if (!adv) {
      body = `<div class="wv-status">${buy.status ? '' : '<span class="wv-spin"></span>'}${esc(buy.status || 'Lecture des ventes…')}</div>`;
    } else if (!adv.enough) {
      body = `<div class="wv-status">Pas assez de ventes${a.rarity ? ` en rareté ${esc(a.rarity)}` : ''} pour estimer un prix (${adv.n}).</div>`;
    } else {
      // Mise à payer : le montant proposé par le site, sinon calculé (départ, ou +10 %).
      const computed = a.current == null ? a.base : nextBid(a.current);
      const pay = pageMinBid() || computed;
      // 0 % = prix de vente rapide estimé (réglable), comme sur les pastilles.
      const pr = buy.price && buy.price.enough ? buy.price : {};
      const ref = refOf({ quick: pr.quick, normal: pr.normal, resaleCap: adv.resaleCap, median: adv.median });
      const delta = pay ? pay / ref.price - 1 : null;
      const collection = !!collectionMem[a.cardId];
      const verdict = pay == null ? null
        : adv.resaleCap !== null && pay <= adv.resaleCap ? ['wv-quick', '✅ Bonne affaire, même pour revendre']
        : pay <= adv.median ? ['wv-ambitious', `${collection ? '★ ' : ''}Acceptable pour la collection (sous la médiane)`]
        : ['wv-bad', '⛔ Trop cher : au-dessus de la médiane'];
      if (pay != null) {
        body += `<div class="wv-row" style="--wv-c:${deltaColor(delta)}"><div>
          <div class="wv-label">${a.current == null ? 'Mise de départ' : 'Prochaine mise'}</div>
          <div class="wv-price">${fmtPrice(pay)}<small>${fmtDelta(delta)} vs ${esc(ref.name)} (${fmtPrice(ref.price)}) · P${Math.round(adv.percentile(pay) * 100)}</small></div>
          ${a.leader ? `<div class="wv-when">En tête : ${esc(a.leader)}${a.current != null ? ` à ${fmtPrice(a.current)}` : ''}</div>` : ''}
        </div></div>`;
        body += `<div class="wv-tip ${verdict[0]}">${esc(verdict[1])}</div>`;
      }
      if (a.shiny) body += `<div class="wv-tip">${esc(shinyNote(buy.via, buy.premium, adv.n))}</div>`;
      // Mises maximales, sur une ligne : revendre, collection.
      const cap = (cls, label, value) => (value === null ? ''
        : `<div class="wv-cap ${cls}"><span>${label}</span><b>${fmtPrice(value)} ${pay == null ? '' : pay <= value ? '✓' : '✗'}</b></div>`);
      body += `<div class="wv-caps">${cap('wv-quick', 'max revente', adv.resaleCap)}`
        + `${cap('wv-ambitious', 'max collection', Math.floor(adv.median))}</div>`;
      if (adv.resaleCap !== null) body += `<div class="wv-status">Revente estimée ${fmtPrice(adv.resale)}</div>`;
      buy.summary = pay == null ? '' : `<span style="color:${deltaColor(delta)}">${fmtDelta(delta)}</span> ${verdict[1].split(' ')[0]}`;
      if (adv.resaleCap === null) body += `<div class="wv-status">Mise max pour revendre : il faut au moins ${CONFIG.buy.minSales} ventes.</div>`;
      body += `<div class="wv-status">Ventes (${esc(adv.period)}) : ${fmtPrice(adv.min)} – ${fmtPrice(adv.max)}, médiane ${fmtPrice(adv.median)}`
        + `${pr.quick != null ? ` · vente rapide ${fmtPrice(pr.quick)}, normale ${fmtPrice(pr.normal)}` : ''}</div>`;
    }
    // Ligne réduite : écart de la prochaine mise et verdict (✅ 👍 ⛔…).
    const summary = !adv ? '<i>…</i>' : !adv.enough ? '<i>trop peu de ventes</i>' : buy.summary || '';
    const html = `<header><span class="wv-title">${title}</span>${pill}<span class="wv-sum">${summary}</span><span class="wv-chevron">${panel.classList.contains('wv-min') ? '▴' : '▾'}</span></header>`
      + `<div class="wv-body">${body}${count ? `<div class="wv-status">${count.replace(/<[^>]+>/g, '')} récentes</div>` : ''}</div>`;
    panel.style.display = 'block';
    if (html !== lastBuyHtml || panel.dataset.mode !== 'buy') panel.innerHTML = html;
    panel.dataset.mode = 'buy';
    lastBuyHtml = html;
  }


  // ---------------------------------------------------------------------------
  // Télécommande du bot de surenchère (comme sur l'ordinateur)
  // ---------------------------------------------------------------------------
  // Sur la page du marché : les enchères où tu as misé, avec les boutons de
  // plafond du bot de la tablette (Revente, Collec., Manuel, Arrêt). Chaque
  // choix part vers la tablette par ntfy.sh (sujet « <sujet>-encheres », celui
  // du bot de surenchère) ; les choix faits ailleurs arrivent ici de la même
  // façon, le plus récent l'emporte. Le téléphone ne mise jamais.
  // Données : la liste « Mes enchères » que la page du marché charge elle-même
  // (aucune requête en plus), relue ensuite toutes les 2 à 5 min tant que la
  // page est affichée ; plafonds calculés comme sur la tablette (revente = valeur
  // de revente / 1,25 dès 8 ventes, collection = médiane dès 3 ventes).
  const KEY_R_TOPIC = 'wr.topic';
  const KEY_R_MODES = 'wr.modes';
  const KEY_R_MODES_AT = 'wr.modesAt';
  const KEY_R_SINCE = 'wr.syncSince';
  // Identifiant du compte (v1.4.0) : nouvelle clé, apprise seulement dans vos
  // ventes en cours et vos enchères gagnées. L'ancienne (« wr.me ») pouvait
  // venir d'une requête de profil d'un autre joueur.
  const KEY_R_ME = 'wr.account';
  const idOf = (x) => (x ? String(x).toLowerCase() : null);
  // Plafond « Manuel… » : même règle que la surenchère de la tablette, un nombre
  // entier de wikibidous entre 1 et R_MAX_MANUAL. Toute autre valeur, saisie
  // ou reçue par ntfy, est refusée.
  const R_MAX_MANUAL = 10000;
  const R_UUID = new RegExp(`^${UUID}$`, 'i');
  const rValidManual = (v) => Number.isInteger(v) && v >= 1 && v <= R_MAX_MANUAL;
  const rValidMode = (m) => m === 'resale' || m === 'collection' || m === 'off' || m === 'keep' || rValidManual(m);
  // Montant saisi : chiffres, éventuellement séparés par milliers (« 1 200 »,
  // « 1.200 »). Une décimale (« 12,5 ») est refusée : avant la v1.4.0, elle
  // donnait 125.
  function parseAmount(text) {
    const s = String(text || '').replace(/[\s  ]/g, '');
    if (/^\d+$/.test(s)) return Number(s);
    if (/^\d{1,3}([.,'’]\d{3})+$/.test(s)) return Number(s.replace(/[.,'’]/g, ''));
    return null;
  }
  // Plafonds par carte, rareté et version (normale ou shiny).
  const capsKey = (a) => `${a.cardId}|${a.rarity}|${a.shiny ? 1 : 0}`;
  const rTopic = () => GM_getValue(KEY_R_TOPIC, '');
  const rSyncTopic = () => (rTopic() ? `${rTopic()}-encheres` : '');
  const remote = { followed: [], readAt: 0, nextRead: 0, reading: false, status: '', syncStatus: '—', nextSync: 0, syncing: false,
    caps: new Map(), capsBusy: new Set(), touchedAt: 0, lastHtml: '' };
  // Sur toutes les pages du marché, sauf la page d'une enchère (où s'affiche
  // l'aide à l'achat). Sans sujet ntfy, le bandeau propose de l'activer.
  const remoteShown = () => location.pathname.startsWith('/marketplace') && !AUCTION_PATH.test(location.pathname)
    && (!!rTopic() || !GM_getValue('wr.off', false));
  function remoteSetup() {
    const answer = prompt('Télécommande des enchères : nom du sujet ntfy du bot de surenchère (le même que sur la tablette : '
      + 'menu du bot de surenchère → « Notifications téléphone »).\nVide pour désactiver.', rTopic());
    if (answer === null) return;
    const topicName = answer.trim().replace(/[^A-Za-z0-9_-]/g, '');
    GM_setValue(KEY_R_TOPIC, topicName);
    // Laissé vide : plus de bandeau (réactivable par le menu du script).
    GM_setValue('wr.off', !topicName);
    if (!topicName) panel.style.display = 'none';
    Object.assign(remote, { nextSync: 0, lastHtml: '' });
    render();
  }

  function noteFollowed(data) {
    const me = idOf(((data.selling || [])[0] || {}).seller_id) || idOf(((data.won || [])[0] || {}).winner_id);
    if (me && GM_getValue(KEY_R_ME, null) !== me) GM_setValue(KEY_R_ME, me);
    remote.followed = data.bidding.filter((a) => a && a.status === 'active').map((a) => ({
      id: a.id,
      cardId: a.card_id,
      title: (a.card && a.card.wikipedia_title) || '?',
      rarity: a.snapshot_rarity || (a.card && a.card.rarity) || null,
      shiny: a.is_shiny === true,
      base: a.base_amount,
      current: a.current_bid,
      leader: idOf(a.current_bidder_id),
      leaderName: a.current_bidder && a.current_bidder.username,
      end: Date.parse(a.end_at),
    }));
    remote.readAt = Date.now();
    remote.nextRead = Date.now() + between(120000, 300000);
  }

  function rSetMode(id, mode, at) {
    if (!rValidMode(mode)) return false;
    const all = GM_getValue(KEY_R_MODES, {});
    const stamps = GM_getValue(KEY_R_MODES_AT, {});
    if (stamps[id] && stamps[id] >= at) return false;
    all[id] = mode;
    stamps[id] = at;
    GM_setValue(KEY_R_MODES, all);
    GM_setValue(KEY_R_MODES_AT, stamps);
    return true;
  }
  function rCapOf(a) {
    let mode = GM_getValue(KEY_R_MODES, {})[a.id] || 'resale';
    if (mode === 'keep') mode = 'resale'; // option « Garder » supprimée
    const c = remote.caps.get(capsKey(a)) || null;
    if (mode === 'off') return { mode, cap: null, c };
    if (typeof mode === 'number') return rValidManual(mode) ? { mode: 'manual', cap: mode, c } : { mode: 'manual', cap: null, c, invalid: true };
    if (mode !== 'resale' && mode !== 'collection') return { mode: 'resale', cap: null, c, invalid: true };
    return { mode, cap: c ? (mode === 'collection' ? c.collection : c.resale) : null, c };
  }

  function ntfyRequest(method, url, data) {
    return new Promise((resolve) => {
      try {
        GM_xmlhttpRequest({
          method,
          url,
          data,
          headers: data ? { 'Content-Type': 'application/json' } : {},
          timeout: 15000,
          onload: (res) => resolve(res.status >= 200 && res.status < 300 ? res.responseText : null),
          onerror: () => resolve(null),
          ontimeout: () => resolve(null),
        });
      } catch (err) {
        resolve(null);
      }
    });
  }
  // Priorité 1 : message de service, jamais affiché ni sonné sur le téléphone.
  const rPublish = (id, mode) => rSyncTopic() && ntfyRequest('POST', 'https://ntfy.sh/',
    JSON.stringify({ topic: rSyncTopic(), message: JSON.stringify({ t: 'mode', id, mode, at: Date.now() }), priority: 1 }));
  async function rPullModes() {
    if (!rSyncTopic() || remote.syncing || Date.now() < remote.nextSync) return;
    remote.syncing = true;
    remote.nextSync = Date.now() + between(20000, 40000);
    try {
      const since = GM_getValue(KEY_R_SINCE, '12h');
      const text = await ntfyRequest('GET', `https://ntfy.sh/${rSyncTopic()}/json?poll=1&since=${encodeURIComponent(since)}`);
      if (text === null) {
        remote.syncStatus = `échec à ${hhmm(Date.now())}`;
        return;
      }
      let lastId = null;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.event !== 'message') continue;
          lastId = ev.id;
          const msg = JSON.parse(ev.message);
          if (!msg || msg.t !== 'mode') continue;
          // Contrôle (v1.4.0) : enchère au format attendu, choix valide, date
          // plausible (une date dans le futur bloquerait les choix suivants).
          if (typeof msg.id === 'string' && R_UUID.test(msg.id) && rValidMode(msg.mode)
            && Number.isFinite(msg.at) && msg.at <= Date.now() + 5 * 60000 && msg.at >= Date.now() - 13 * 3600000) {
            rSetMode(msg.id.toLowerCase(), msg.mode, msg.at);
          }
        } catch (err) {
          // message étranger : ignoré
        }
      }
      if (lastId) GM_setValue(KEY_R_SINCE, lastId);
      remote.syncStatus = hhmm(Date.now());
    } finally {
      remote.syncing = false;
    }
  }

  function remoteChoose(id, mode, title) {
    let value = mode;
    if (mode === 'manual') {
      const answer = prompt(`Plafond pour « ${title} » (nombre entier de wikibidous) :`, '');
      if (answer === null || !answer.trim()) return;
      value = parseAmount(answer);
      if (!rValidManual(value)) {
        alert(`Montant refusé : « ${answer.trim()} ».\nÉcris un nombre entier de wikibidous, sans décimales (par exemple 1250 ou 1 250), entre 1 et ${fmtPrice(R_MAX_MANUAL)}.`);
        return;
      }
      // Confirmation, avec l'écart à la médiane quand elle est connue.
      const a = remote.followed.find((x) => x.id === id);
      const c = a ? remote.caps.get(capsKey(a)) : null;
      const median = c ? c.median : null;
      const ratio = median ? ` (médiane ${fmtPrice(median)}, soit ×${(value / median).toFixed(1).replace('.', ',')})` : '';
      if (!confirm(`Plafond pour « ${title} » : ${fmtPrice(value)} wikibidous${ratio}.\n\nLa tablette pourra miser jusqu’à ce montant. Confirmer ?`)) return;
    }
    rSetMode(id, value, Date.now());
    rPublish(id, value);
    remote.touchedAt = 0;
    render();
  }

  async function remoteTick() {
    if (!remoteShown() || !rTopic()) return;
    rPullModes();
    // Relecture de « Mes enchères » (la page l'a lue au chargement).
    if (!remote.reading && Date.now() >= remote.nextRead) {
      remote.reading = true;
      remote.nextRead = Date.now() + between(120000, 300000);
      const url = `${location.origin}/api/marketplace?page=1&limit=50&sort=recent&mine=1`;
      try {
        await gateWait('urgent', url);
        const res = await pageFetch(url);
        if (res.ok) {
          noteAuctions(await res.json());
          remote.status = '';
        } else {
          if (isRateRefusal(res.status, url)) gate.refused(res.status);
          remote.status = `Lecture de « Mes enchères » impossible (HTTP ${res.status}).`;
        }
      } catch (err) {
        remote.status = `Lecture de « Mes enchères » impossible (${err.message}).`;
      } finally {
        remote.reading = false;
      }
    }
    // Plafonds : historique de chaque carte suivie (gardé 10 min). Même règle
    // que la tablette (v1.4.0) : ventes shiny écartées pour une carte normale ;
    // enchère shiny → ses propres ventes shiny dès ownMinSales ventes, sinon
    // plafonds d'une carte normale (prudent, sans prime).
    for (const a of remote.followed) {
      const key = capsKey(a);
      const known = remote.caps.get(key);
      if ((known && Date.now() - known.at < 600000) || remote.capsBusy.has(key)) continue;
      remote.capsBusy.add(key);
      fetchSales(a.cardId, CONFIG.buy.cacheMinutes * 60000, 'bulk').then((data) => {
        const own = a.shiny ? adviceFor(data.sales || [], a.rarity, true).buy : null;
        const useOwn = !!own && own.enough && own.n >= CONFIG.shiny.ownMinSales;
        const b = useOwn ? own : adviceFor(data.sales || [], a.rarity, false).buy;
        // 3 à 7 ventes : revente prudente, 80 % de la vente la plus basse, comme la tablette (v1.6.3).
        const thin = b.enough && b.resaleCap == null && b.min != null ? Math.floor(b.min / (1 + CONFIG.buy.resaleMargin)) : null;
        remote.caps.set(key, { at: Date.now(), n: b.n || 0, resale: b.enough ? (b.resaleCap ?? thin) : null, thin: thin != null,
          collection: b.enough ? Math.floor(b.median) : null, median: b.enough ? b.median : null, shinyFallback: a.shiny && !useOwn });
      }).catch(() => {}).finally(() => remote.capsBusy.delete(key));
    }
  }

  const rLeft = (end) => {
    const sec = Math.max(0, Math.round((end - Date.now()) / 1000));
    return sec >= 3600 ? `${Math.floor(sec / 3600)} h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`
      : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  };
  // Redessiné seulement quand le contenu change, jamais pendant qu'on touche
  // ou fait défiler la liste ; les comptes à rebours sont mis à jour à part.
  function renderRemote() {
    if (!rTopic()) {
      const setup = '<header><span class="wv-title">Télécommande des enchères</span><span class="wv-sum"><i>toucher pour activer</i></span></header>';
      panel.style.display = 'block';
      if (panel.dataset.mode !== 'remote-setup') {
        panel.innerHTML = setup;
        panel.dataset.mode = 'remote-setup';
      }
      return;
    }
    const me = GM_getValue(KEY_R_ME, null);
    const nextOf = (a) => (a.current == null ? a.base : nextBid(a.current));
    // Prochaine mise au-dessus du plafond : en rouge, en bas de la liste.
    const overCap = (a) => {
      if (me && a.leader === me) return false;
      const { mode, cap } = rCapOf(a);
      return mode !== 'off' && cap != null && nextOf(a) > cap;
    };
    const list = remote.followed.filter((a) => a.end > Date.now() - 60000)
      .sort((a, b) => (overCap(a) - overCap(b)) || (a.end - b.end));
    const rows = list.map((a) => {
      const { mode, cap, c, invalid } = rCapOf(a);
      const lead = !!me && a.leader === me;
      const over = overCap(a);
      const cls = mode === 'off' ? 'wr-stop' : lead ? 'wr-lead' : over ? 'wr-over' : 'wr-behind';
      const btn = (m, label) => `<button data-id="${esc(a.id)}" data-title="${esc(a.title)}" data-rmode="${m}" class="${mode === m ? 'on' : ''}">${label}</button>`;
      const next = nextOf(a);
      const capNote = invalid ? ' (plafond manuel refusé : choisis-en un autre)'
        : c && cap == null && mode !== 'off' ? ` (${c.n} ventes : pas assez)`
          : a.shiny && c && c.shinyFallback && mode !== 'manual' && mode !== 'off' ? ' (shiny : plafond d’une carte normale)' : '';
      return `<div class="wr-row ${cls}">
        <div class="wr-t"><span>${esc(a.title)}${a.rarity ? ` · ${esc(a.rarity)}` : ''}${a.shiny ? ' ✦' : ''}</span><span class="wr-left" data-end="${a.end}"></span></div>
        <div class="wr-s">Mise ${fmtPrice(a.current ?? a.base)} · ${lead ? 'tu es en tête' : `en tête : ${esc(a.leaderName || '—')}`} · prochaine ≥ ${fmtPrice(next)}</div>
        <div class="wr-s">Plafond ${cap == null ? '—' : fmtPrice(cap)}${over ? ' · dépassé' : ''}${capNote}</div>
        <div class="wr-modes">${btn('resale', `Revente${c && c.resale != null ? ` ${fmtPrice(c.resale)}` : ''}`)}${btn('collection', `Collec.${c && c.collection != null ? ` ${fmtPrice(c.collection)}` : ''}`)}${btn('manual', mode === 'manual' ? `Manuel ${fmtPrice(cap)}` : 'Manuel…')}${btn('off', 'Arrêt')}</div>
      </div>`;
    }).join('');
    const soonest = list.find((a) => a.end > Date.now());
    const summary = `${list.length} enchère${list.length > 1 ? 's' : ''}${soonest ? ` · <span class="wr-left" data-end="${soonest.end}"></span>` : ''}`;
    const html = `<header><span class="wv-title">Mes enchères</span><span class="wv-sum">${summary}</span><span class="wv-chevron">${panel.classList.contains('wv-min') ? '▴' : '▾'}</span></header>`
      + `<div class="wv-body">${rows || '<div class="wv-status">Aucune enchère en cours où tu as misé.</div>'}`
      + `${remote.status ? `<div class="wv-status">${esc(remote.status)}</div>` : ''}`
      + `<div class="wv-status">Télécommande : les choix partent vers la tablette (prise en compte en moins d’une minute). Synchro : ${esc(remote.syncStatus)}.</div></div>`;
    panel.style.display = 'block';
    if ((html !== remote.lastHtml || panel.dataset.mode !== 'remote') && Date.now() - remote.touchedAt > 1500) {
      const body = panel.querySelector('.wv-body');
      const scroll = body ? body.scrollTop : 0;
      panel.innerHTML = html;
      const fresh = panel.querySelector('.wv-body');
      if (fresh) fresh.scrollTop = scroll;
      panel.dataset.mode = 'remote';
      remote.lastHtml = html;
    }
    for (const span of panel.querySelectorAll('.wr-left')) {
      const text = rLeft(Number(span.dataset.end));
      if (span.textContent !== text) span.textContent = text;
    }
  }
  for (const type of ['pointerdown', 'touchstart', 'scroll']) {
    panel.addEventListener(type, () => { remote.touchedAt = Date.now(); }, { passive: true, capture: true });
  }

  GM_registerMenuCommand(`Télécommande des enchères : ${rTopic() ? 'régler' : 'activer'}`, () => {
    remoteSetup();
    alert(rTopic() ? `Télécommande activée (sujet ${rTopic()}). Elle s’affiche sur la page du marché.` : 'Télécommande désactivée.');
  });

  // ---------------------------------------------------------------------------
  // Diagnostic : seulement la fenêtre de la carte, pour caler les sélecteurs
  // ---------------------------------------------------------------------------

  const KEEP_ATTRS = /^(id|class|role|type|name|placeholder|value|href|alt|title|disabled|inputmode|min|max|step|aria-.*|data-.*)$/;
  function outline(node, depth) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = norm(node.textContent);
      return t ? '  '.repeat(depth) + JSON.stringify(t.slice(0, 80)) + '\n' : '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node === panel) return '';
    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'link', 'meta'].includes(tag)) return '';
    const attrs = [...node.attributes].filter((a) => KEEP_ATTRS.test(a.name)).map((a) => `${a.name}="${a.value.slice(0, 160)}"`);
    const head = '  '.repeat(depth) + `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
    if (tag === 'svg') return head + '\n';
    return head + '\n' + [...node.childNodes].map((c) => outline(c, depth + 1)).join('');
  }

  // Sans fiche repérée : les derniers éléments superposés de la page (fenêtres).
  function overlays() {
    return [...document.body.querySelectorAll('*')].filter((el) => {
      if (el === panel || panel.contains(el)) return false;
      const cs = getComputedStyle(el);
      return (cs.position === 'fixed' || el.matches('[role="dialog"], [aria-modal="true"]')) && isVisible(el)
        && el.getBoundingClientRect().width > 200;
    }).slice(-3);
  }

  GM_registerMenuCommand(`Ouverture auto de l’onglet Marché : ${autoOpenAllowed() ? 'oui' : 'non'} (changer)`, () => {
    GM_setValue(KEY_AUTO_OPEN, !autoOpenAllowed());
    alert(`Ouverture automatique de l’onglet Marché : ${autoOpenAllowed() ? 'OUI' : 'NON'}.\n`
      + 'Sans elle, une carte jamais vue se reconnaît quand tu ouvres toi-même « Marché » une fois. La page va se recharger.');
    location.reload();
  });

  GM_registerMenuCommand(`Encart : ${GM_getValue(KEY_TOP, false) ? 'en haut' : 'en bas'} de l’écran (changer)`, () => {
    const top = !GM_getValue(KEY_TOP, false);
    GM_setValue(KEY_TOP, top);
    panel.classList.toggle('wv-top', top);
    alert(`L’encart s’affichera ${top ? 'en haut' : 'en bas'} de l’écran.`);
  });

  GM_registerMenuCommand(`Pastilles du marché : 0 % = ${DELTA_REFS[deltaRef()]} (changer)`, () => {
    const order = Object.keys(DELTA_REFS);
    const next = order[(order.indexOf(deltaRef()) + 1) % order.length];
    GM_setValue(KEY_DELTA_REF, next);
    alert(`Pastilles du marché et encart d’une enchère : 0 % = ${DELTA_REFS[next]}.\nLa page va se recharger.`);
    location.reload();
  });

  // Bilan shiny : prime mesurée, données disponibles, contrôle ventes ↔ enchères.
  function shinyReport() {
    const p = shinyPremiums();
    const line = (label, e) => `${label} : ${e.beta === null ? `pas encore assez de données (${e.cards} carte(s), il en faut ${CONFIG.shiny.minCards})` : fmtPremium(e)}`;
    const join = Object.values(joinCheck).reduce((acc, e) => {
      acc[e[2] || 'en attente'] = (acc[e[2] || 'en attente'] || 0) + 1;
      return acc;
    }, {});
    const tracked = Object.values(shinyAuctions);
    return [
      line('Prime shiny, toutes raretés', p.all),
      ...RARITIES.filter((r) => p.byRarity[r]).map((r) => line(`  ${r}`, p.byRarity[r])),
      `Ventes shiny mesurées : ${Object.keys(shinyPairs).length} · enchères shiny suivies : ${tracked.length} (${tracked.filter((e) => e[3]).length} terminées et relues)`,
      `Le site indique shiny dans l’historique des ventes : ${shinyField ? 'oui' : 'non (vu jusqu’ici)'}`,
      `Ventes ↔ enchères (même identifiant) : ${JSON.stringify(join)}`,
    ].join('\n');
  }
  GM_registerMenuCommand('Débit vers le site : voir (ou recalibrer)', () => {
    if (confirm(`Débit vers le site (aide à la vente et surenchère, tous les onglets) :\n${gate.status()}\n\n`
      + 'Recalibrer ? Les plafonds repartent du départ prudent et remontent doucement (OK = recalibrer, Annuler = ne rien changer).')) {
      gate.reset();
      alert('Plafonds remis au départ prudent.');
    }
  });

  GM_registerMenuCommand('Prime shiny : voir l’estimation', () => {
    alert(`${shinyReport()}\n\nComment c’est mesuré : chaque vente shiny connue est comparée aux ventes normales de la même carte `
      + `(même rareté, à ±${CONFIG.shiny.baselineDays} jours). Chaque carte compte une fois ; on prend la médiane entre cartes, `
      + 'avec un intervalle de confiance à 90 % (bootstrap). Les ventes shiny sont reconnues grâce aux enchères shiny vues sur le marché : '
      + 'plus tu passes sur le marché, plus la mesure est précise.');
  });

  GM_registerMenuCommand('Copier le diagnostic (fiche ou marché)', () => {
    const view = cardView();
    const roots = view ? [view.container] : overlays();
    const report = [
      `URL : ${location.href}`,
      `Version : ${scriptVersion()} · copies actives sur la page : ${activeCopies()}`,
      `Fiche repérée : ${view ? 'oui' : 'non'} · onglet Marché : ${view ? view.onMarket : '—'} · formulaire ouvert : ${view ? view.formOpen : '—'}`,
      `Titres : ${view ? cardTitles(view.container).join(' | ') : '—'} · rareté : ${view ? cardRarity(view.container) : '—'}`,
      `Identifiants vus dans les requêtes : ${seenIds.slice(0, 5).join(', ') || 'aucun'}`,
      `Dernière lecture des ventes : ${lastFetch}`,
      `Carte reconnue : ${state.card ? `${state.card.data.wikipedia_title} (${state.card.id})` : 'non'}`,
      `Champ du prix : ${view && priceInput(view.container) ? 'trouvé' : 'non trouvé'}`,
      `Ventes collectées : ${Object.values(GM_getValue(KEY_SALES, {})).reduce((n, e) => n + e.s.length, 0)}`,
      `Cartes mémorisées : ${Object.keys(idsMem).length} · clics automatiques sur « Marché » depuis le chargement : ${autoClicks}`,
      `Marché : ${listUrls.size} liste(s) vue(s), dernière lecture ${listStatus} · ${auctions.size} enchères connues · ${badges.size} pastilles`,
      `Lectures des ventes : ${readStats.ok} réussies, erreurs ${JSON.stringify(readStats.errors)}, `
        + `durée moyenne ${readStats.ok ? (readStats.totalMs / readStats.ok / 1000).toFixed(1) : '—'} s, max ${(readStats.maxMs / 1000).toFixed(1)} s, `
        + `${readStats.inflightMax} en parallèle au plus`,
      `Débit vers le site : ${gate.status()}`,
      `Réponses de la page lues : ${hookedResponses} · résumés de cartes : ${Object.keys(summaries).length} · pastilles de la collection : ${cardBadges.size}`,
      `Télécommande : ${rTopic() ? `sujet ${rTopic()}` : 'pas activée'} · enchères suivies ${remote.followed.length} · synchro ${remote.syncStatus} · page ${location.pathname}`,
      `Relais dans la page : ${bridgeReady ? 'actif' : 'inactif (requêtes directes)'} · minuteries : ${workerOk ? 'worker' : 'setTimeout'} · 0 % des pastilles : ${DELTA_REFS[deltaRef()]}`,
      `Achats connus : ${Object.keys(bought).length}${state.card ? ` · cette carte : ${state.purchase ? `${state.purchase.price} (${state.purchase.rarity || '?'})` : 'aucun'}` : ''}`
        + ` · fiche shiny : ${state.view ? state.shiny : '—'}`,
      shinyReport(),
      (location.pathname.startsWith('/collection') || onProfile()) && !view
        ? gridCards().slice(0, 12).map((c) => `- ${c.title} (${c.rarity || '?'}) → ${knownId(c.title) || 'non reconnue'}`).join('\n')
          + '\n' + (gridCards()[0] ? outline(gridCards()[0].face.parentElement, 0).slice(0, 4000)
            : `(aucune carte de grille trouvée)\n${onProfile() ? outline(document.querySelector('main') || document.body, 0).slice(0, 12000) : ''}`)
        : '',
      '',
      location.pathname.startsWith('/marketplace') && !view
        ? [...document.querySelectorAll('[id^="marketplace-auction-"]')].slice(0, 2).map((el) => outline(el, 0)).join('\n----\n')
          + '\n----\n' + [...document.querySelectorAll('[id^="marketplace-auction-"]')].slice(0, 12)
            .map((el) => JSON.stringify(listingInfo(el, idsMem))).join('\n')
        : '',
      roots.map((r) => outline(r, 0)).join('\n----\n').slice(0, 60000) || '(aucune fenêtre trouvée)',
    ].join('\n');
    GM_setClipboard(report, 'text');
    alert('Diagnostic de la fiche copié dans le presse-papiers.');
  });

  // Deux copies du script actives (ancienne version jamais supprimée) : elles
  // lisent les ventes chacune de leur côté (deux fois plus de requêtes) et le
  // menu propose deux diagnostics. Chaque copie ajoute son encart et son calque
  // de pastilles : on les compte.
  function scriptVersion() {
    try {
      return GM_info.script.version;
    } catch (err) {
      return '?';
    }
  }
  function activeCopies() {
    return Math.max(document.querySelectorAll('#wv-panel').length, document.querySelectorAll('#wv-badges').length);
  }
  setTimeout(() => {
    const copies = activeCopies();
    if (copies < 2) return;
    console.warn(`[WV] ${copies} copies de l'aide à la vente sont actives`);
    try {
      if (sessionStorage.getItem('wv.dupWarned')) return;
      sessionStorage.setItem('wv.dupWarned', '1');
    } catch (err) {
      // pas de mémoire de session : l'avertissement peut revenir
    }
    alert(`Deux aides à la vente tournent en même temps sur ce téléphone (celle-ci : version téléphone v${scriptVersion()}).\n\n`
      + 'Dans Tampermonkey, désactive « Wiki Masters — aide à la vente » (version ordinateur) : sur le téléphone, seule la version téléphone doit rester active.');
  }, 5000);

  // Exposé pour les tests.
  if (CONFIG.debug) {
    window.__wvm = { priceAdvice, durationAdvice, buildProfile, profileAt, quantile, buyAdvice, resaleValue, reservationPrice, auctions, workerOk: () => workerOk,
      gate, parseAmount, rValidMode, rCapOf, remote, capsKey, summaryFor, salesCache, deadIds };
  }

  // Réponses de la page : identifiants des cartes (titre → id) et enchères.
  const UUID_ONLY = new RegExp(`^${UUID}$`, 'i');
  onPageJson = (url, json) => {
    if (/\/api\/notifications\b/.test(url)) noteNotifications(json);
    const pairs = [];
    let seen = 0;
    (function walk(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth > 6 || seen > 20000) return;
      seen++;
      if (!Array.isArray(obj) && typeof obj.wikipedia_title === 'string') {
        const id = obj.card_id || (obj.card && obj.card.id) || obj.id;
        const title = obj.is_shiny === true ? `${obj.wikipedia_title} ✦` : obj.wikipedia_title;
        if (typeof id === 'string' && UUID_ONLY.test(id)) pairs.push([title, id.toLowerCase()]);
      }
      for (const v of Object.values(obj)) if (v && typeof v === 'object') walk(v, depth + 1);
    })(json, 0);
    if (pairs.length) rememberIds(pairs);
    // Ventes chargées par la page elle-même (onglet « Marché », fiche d'enchère) :
    // gardées comme si le script les avait lues.
    const salesUrl = new RegExp(`/api/marketplace/cards/${UUID}/sales`, 'i').exec(url);
    if (salesUrl && json && Array.isArray(json.sales)) {
      const id = salesUrl[1].toLowerCase();
      cacheSales(id, json);
      summarize(id, json.sales, json.wikipedia_title);
    }
    if (/\/api\/marketplace\?/.test(url)) {
      noteAuctions(json);
      listUrls.set(url, Date.now());
    }
    schedule();
  };
  skipUrl = (url) => ownUrls.has(url);
  early.splice(0).forEach(([url, json]) => onPageJson(url, json));
  }
})();
