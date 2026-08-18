// Bookmarklet "CRM Réponses (auto)" — a coller dans l'URL d'un favori Chrome,
// prefixe par "javascript:" (voir bookmarklet-crm-reponses.min.txt pour la
// version prete a copier-coller directement dans la barre de favoris).
//
// Usage : ouvrir linkedin.com/messaging/, cliquer le favori, entrer le mot de
// passe du CRM une fois. Le script defile la liste des conversations par
// paliers, lit pour chacune le nom, la date du dernier message et QUI l'a
// envoye en dernier (Marie ou le prospect), envoie ca par lots au backend
// Apps Script (action=matcherReponses) qui compare a TOUTE la base (pas
// seulement les prospects deja en cours de relance -- objectif principal :
// retrouver, parmi les ~1800 "Nouveau"/"A traiter" (statut par defaut de
// l'import en lot), ceux qui ont en realite deja une conversation LinkedIn
// des mois d'activite hors CRM). Une fois tous les paquets traites, un
// dernier appel (action=verifierAbsents) signale les prospects deja en cours
// de relance (Premiere/Deuxieme/Reprise de contact) dont aucun fil n'a ete
// repere du tout. Une derniere fenetre (action=voirResultatsSession)
// s'ouvre automatiquement et affiche le recapitulatif complet -- PAS de
// panneau flottant sur LinkedIn (abandonne le 2026-08-17 : LinkedIn bloque
// tous les canaux de retour testes -- postMessage via window.opener coupe
// par sa Cross-Origin-Opener-Policy, JSONP bloque par sa Content-Security-
// Policy script-src -- donc le seul moyen fiable de voir le resultat est
// une page que Code.gs affiche lui-meme, voir Code.gs/afficherResultatsSession).
//
// Cas ECRITS AUTOMATIQUEMENT (signal fiable, valide par Marie), par ordre de
// priorite -- l'anciennete du dernier message (quel que soit l'emetteur)
// passe AVANT tout le reste :
//  1. dernier message il y a >= 6 mois -> "Recontacter"
//  2. dernier message il y a >= 2 semaines (et < 6 mois) -> "Pas maintenant"
//  3. sinon, reponse recue (dernier message du prospect, recent) -> "En
//     conversation"
//  4. sinon, "Nouveau"/"A traiter" avec un stade identifiable (1er message /
//     relance 1 / relance 2) -> reclasse en "Premiere relance" ou "Deuxieme
//     relance" avec Nb relances et la date reelle du dernier envoi
// Cas laisses en INFORMATIF SEULEMENT (pas d'ecriture, decision manuelle) :
//  - stade non identifiable (message reel trop different des signatures
//    connues) sur un "Nouveau"/"A traiter" recent
//  - ecart de stade sur un prospect deja etage (Premiere/Deuxieme relance)
//  - absence totale de fil sur un prospect deja etage
// "Hors cible" reste un tri 100% manuel fait par Marie au fil de ses actions
// -- pas automatise ici.
//
// Construit le 2026-08-14 a partir de captures d'ecran reelles de la
// messagerie de Marie (pas de la doc LinkedIn), puis CORRIGE le 2026-08-15
// apres un premier test en conditions reelles qui n'a capture 0 conversation
// -- LinkedIn n'utilise plus de <a href="/messaging/thread/...">  dans la
// liste (verifie en direct sur linkedin.com/messaging/ via l'extension
// Claude in Chrome) : chaque ligne est un <li class="msg-conversation-listitem">
// sans lien reel, dont le nom/date/dernier message vivent dans trois
// elements separes (voir extraireConversation). Chaque ligne de conversation
// affiche "{Nom}" / "{Date}" / "{Emetteur} : {extrait}" (ou "{Emetteur} a
// envoye une piece jointe" pour les messages non textuels), ou Emetteur vaut
// "Vous" (elle a envoye en dernier, toujours en attente) ou le prenom du
// prospect (il/elle a repondu en dernier). C'est ce couple (Vous vs prenom) +
// la date qui permet de classifier sans ambiguite qui a la balle.

(function () {
  // Un "/u/0/" avait ete ajoute ici le 2026-08-16 pour forcer un compte
  // Google specifique, suite a un blocage Drive ("Impossible d'ouvrir le
  // fichier"). Retire le 2026-08-17 : verifie en conditions reelles que
  // l'URL sans index fonctionne directement (aucune redirection vers un
  // "/u/N/", reponse Code.gs recue normalement) -- forcer "/u/0/" causait en
  // fait le meme blocage "Impossible d'ouvrir le fichier" dans le contexte
  // d'une fenetre ouverte depuis linkedin.com (index 0 n'y designe pas le
  // bon compte). Si ce blocage revient, verifier plutot en ouvrant cette URL
  // telle quelle dans un nouvel onglet du meme profil Chrome : si elle
  // redirige vers un "/u/N/" precis, c'est CET index qu'il faut coder ici --
  // pas une valeur arbitraire.
  var URL_BASE = "https://script.google.com/macros/s/AKfycbxZzn8VyJR3YvGohJUbiUA4uAaXlUZRjmRRl4ZA4LhvTb57DnmwCzbfwUFGu5Zl6xml/exec";

  // Memorise les fils deja envoyes a matcherReponses (localStorage, cote
  // linkedin.com, persiste entre les sessions) -- avec potentiellement
  // 1000-2000 conversations a couvrir, Marie va relancer ce bookmarklet
  // plusieurs fois ; sans ca, chaque run re-scrollerait et re-enverrait les
  // memes conversations recentes deja traitees avant d'atteindre du nouveau
  // territoire. Un fil deja reclasse (Recontacter/Pas maintenant/etc.) sort
  // de toute facon du pool de candidats cote serveur (voir Code.gs,
  // STATUTS_ELIGIBLES_TRI) -- ce cache evite juste le gaspillage de temps de
  // defilement et d'appels reseau, ce n'est pas une garantie de correction.
  // Cle : pas de href stable disponible (voir collecter/extraireConversation
  // -- LinkedIn ne rend plus la liste avec de vrais liens), donc nom+date+
  // debut du dernier message. Best-effort seulement : si le texte affiche
  // change (nouveau message, date qui glisse de "hier" a "2j"), la meme
  // conversation peut se represente et se renvoyer -- sans consequence, cote
  // serveur matcherReponses ecrase juste la meme ligne avec le meme resultat.
  var CLE_STOCKAGE = "crmaime_reponses_traitees";
  function chargerTraites() {
    try { return JSON.parse(localStorage.getItem(CLE_STOCKAGE) || "[]").reduce(function (acc, h) { acc[h] = true; return acc; }, {}); }
    catch (err) { return {}; }
  }
  function sauvegarderTraites(map) {
    try { localStorage.setItem(CLE_STOCKAGE, JSON.stringify(Object.keys(map))); } catch (err) {}
  }
  function clefConversation(nom, date, extrait) {
    return nom + "||" + date + "||" + (extrait || "").slice(0, 40);
  }
  var dejaTraites = chargerTraites();
  var nouvellesClefs = [];
  var ignoresDejaTraites = 0;

  var pwd = prompt("Mot de passe du CRM ?", "");
  if (pwd === null) return;
  var reponse = prompt("Combien de paliers de defilement ? (chaque palier ~= quelques conversations ; monter haut (ex. 100+) pour couvrir plusieurs mois d'historique -- les conversations deja traitees lors d'un run precedent sont ignorees automatiquement)", "60");
  if (reponse === null) return;
  var PALIERS = parseInt(reponse, 10);
  if (!PALIERS || PALIERS < 1) PALIERS = 60;
  var PAS = 600;
  var DELAI = 1400;
  var conversations = [];
  var vus = {};

  // Reprise de nettoyerBoilerplate (bookmarklet-crm-auto.js) pour couper les
  // badges connus ("#OPENTOWORK", degre de connexion) qui peuvent se coller
  // au nom sans separateur.
  function nettoyerBoilerplate(texte) {
    return texte
      .replace(/#.*$/, "")
      .replace(/est à l[’']écoute de nouvelles opportunités.*$/i, "")
      .replace(/is open to work.*$/i, "")
      .replace(/is hiring.*$/i, "")
      .replace(/\s*[•·]\s*(1er|2e|3e|1st|2nd|3rd)\+?.*$/i, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // Estimation de la date reelle (et de l'anciennete en jours) du dernier
  // message, a partir du texte de date affiche par LinkedIn -- sert au seuil
  // "Recontacter" (6 mois sans reponse) ET, quand un stade de message est
  // identifie, a remplir la vraie date d'envoi (Date 1er message / date
  // reelle de relance) sur les prospects reclasses depuis "Nouveau"/"A
  // traiter". Approximatif par construction : "12 juin" sans annee (format le
  // plus courant sur les fils de quelques mois) suppose l'annee en cours, en
  // reculant d'un an si la date tomberait dans le futur -- imprecision
  // possible de quelques jours, sans consequence sur un seuil a 6 mois ni sur
  // une date affichee a titre indicatif.
  var MOIS_FR = { "janv": 0, "fevr": 1, "mars": 2, "avr": 3, "mai": 4, "juin": 5, "juil": 6, "aout": 7, "sept": 8, "oct": 9, "nov": 10, "dec": 11 };
  function dateIso(d) {
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var jj = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + mm + "-" + jj;
  }
  function parseDateLinkedIn(texte) {
    var t = texte.toLowerCase();
    var maintenant = new Date();
    if (/aujourd['’]hui/.test(t) || /\d{1,2}:\d{2}/.test(t)) return { ageJours: 0, dateISO: dateIso(maintenant) };
    if (/hier/.test(t)) { var h = new Date(maintenant); h.setDate(h.getDate() - 1); return { ageJours: 1, dateISO: dateIso(h) }; }
    var m = t.match(/il y a (\d+)\s*j/);
    if (m) { var d1 = new Date(maintenant); d1.setDate(d1.getDate() - parseInt(m[1], 10)); return { ageJours: parseInt(m[1], 10), dateISO: dateIso(d1) }; }
    m = t.match(/il y a (\d+)\s*sem/);
    if (m) { var jrs = parseInt(m[1], 10) * 7; var d2 = new Date(maintenant); d2.setDate(d2.getDate() - jrs); return { ageJours: jrs, dateISO: dateIso(d2) }; }
    m = t.match(/il y a (\d+)\s*mois/);
    if (m) { var jrs2 = parseInt(m[1], 10) * 30; var d3 = new Date(maintenant); d3.setDate(d3.getDate() - jrs2); return { ageJours: jrs2, dateISO: dateIso(d3) }; }
    m = t.match(/(\d{1,2})\s*([a-zûé]+)\.?\s*(\d{4})?/);
    if (m) {
      var moisTxt = m[2].normalize("NFD").replace(/[̀-ͯ]/g, "").slice(0, 5);
      var moisIdx = -1;
      for (var k in MOIS_FR) { if (moisTxt.indexOf(k.slice(0, 4)) === 0 || k.indexOf(moisTxt.slice(0, 4)) === 0) { moisIdx = MOIS_FR[k]; break; } }
      if (moisIdx === -1) return { ageJours: null, dateISO: null };
      var annee = m[3] ? parseInt(m[3], 10) : maintenant.getFullYear();
      var d = new Date(annee, moisIdx, parseInt(m[1], 10));
      if (!m[3] && d.getTime() > Date.now()) d.setFullYear(annee - 1);
      return { ageJours: Math.round((Date.now() - d.getTime()) / 86400000), dateISO: dateIso(d) };
    }
    return { ageJours: null, dateISO: null };
  }

  // Nom, date et dernier message vivent dans trois elements separes de la
  // ligne (verifie le 2026-08-15 sur le DOM reel, voir commentaire d'entete) :
  //  - [class*="participant-names"] : nom du/des participant(s)
  //  - [class*="time-stamp"]        : date/heure du dernier message
  //  - [class*="message-snippet"]   : "{Emetteur} : {extrait}" pour un
  //    message texte, ou "{Emetteur} a envoye une piece jointe"/"a reagi"/...
  //    pour un contenu non textuel (pas de ":"). Emetteur vaut "Vous" ou le
  //    prenom du prospect dans les deux cas.
  function extraireConversation(li) {
    var nomEl = li.querySelector('[class*="participant-names"]');
    var dateEl = li.querySelector('[class*="time-stamp"]');
    var snippetEl = li.querySelector('[class*="message-snippet"]');
    if (!nomEl || !dateEl) return null;
    var nom = nettoyerBoilerplate((nomEl.textContent || "").replace(/\s+/g, " ").trim());
    if (!nom || nom.length > 60) return null;
    var dateTexte = (dateEl.textContent || "").replace(/\s+/g, " ").trim();
    if (!dateTexte) return null;
    var snippet = (snippetEl ? snippetEl.textContent : "").replace(/\s+/g, " ").trim();

    var emetteur = null;
    var extrait = snippet;
    var mColon = snippet.match(/^([^:]{1,40}?)\s*:\s*(.*)$/);
    if (mColon) {
      emetteur = mColon[1].trim();
      extrait = mColon[2].trim().slice(0, 140);
    } else {
      // Pas de ":" -- message non textuel ("X a envoye une piece jointe", "X
      // a reagi a...", etc.). Le premier mot est l'emetteur ("Vous" ou le
      // prenom), le reste sert d'extrait informatif (jamais compare aux
      // signatures de stade cote serveur, qui portent sur du texte reel).
      var mAction = snippet.match(/^(\S+)\s+(a\s|vous\s)/i);
      if (mAction) emetteur = mAction[1].trim();
      extrait = snippet.slice(0, 140);
    }

    var parsed = parseDateLinkedIn(dateTexte);
    return {
      nom: nom,
      date: dateTexte,
      ageJours: parsed.ageJours,
      dateISO: parsed.dateISO,
      // null (emetteur non identifie) plutot que de deviner -- seul un
      // "false" explicite declenche la reconciliation automatique "reponse
      // recue" cote serveur (voir Code.gs, matcherReponses).
      dernierEnvoyeurEstMarie: emetteur ? /^vous$/i.test(emetteur) : null,
      extrait: extrait
    };
  }

  // LinkedIn charge la liste par occlusion (les <li> hors viewport sont des
  // coquilles vides, classe "msg-conversation-card--occluded", tant qu'on ne
  // scrolle pas) -- MAIS la page elle-meme ne defile jamais (verifie en
  // direct : document.documentElement.scrollHeight === clientHeight, mise en
  // page fixe). Le vrai conteneur scrollable est le <ul> ancetre du premier
  // <li>, plus haut dans l'arbre (verifie : scrollHeight 1888 vs clientHeight
  // 572, overflow-y:auto). window.scrollBy ne fait donc rien et plafonne la
  // capture aux ~10 conversations deja visibles au chargement -- cette
  // fonction retrouve dynamiquement ce conteneur (pas de classe fixee en dur,
  // pour survivre aux prochains changements de nom de classe LinkedIn).
  function conteneurListe() {
    var li = document.querySelector("li.msg-conversation-listitem");
    var el = li ? li.parentElement : null;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 2) return el;
      el = el.parentElement;
    }
    return null;
  }

  function collecter() {
    document.querySelectorAll("li.msg-conversation-listitem").forEach(function (li) {
      var conv = extraireConversation(li);
      if (!conv) return;
      var clef = clefConversation(conv.nom, conv.date, conv.extrait);
      if (vus[clef]) return;
      if (dejaTraites[clef]) { vus[clef] = true; ignoresDejaTraites++; return; }
      nouvellesClefs.push(clef);
      vus[clef] = true;
      conversations.push(conv);
    });
  }

  // ─── Panneau flottant de resultats ───

  // Petit avis local (pas de suggestions a lister ici -- voir plus bas
  // pourquoi le vrai resultat s'affiche desormais dans une fenetre a part,
  // pas dans un panneau sur cet onglet).
  function afficherAvis(titre, texte) {
    var ancien = document.getElementById("crmaime-panneau-reponses");
    if (ancien) ancien.remove();

    var panneau = document.createElement("div");
    panneau.id = "crmaime-panneau-reponses";
    panneau.style.cssText = "position:fixed;top:20px;right:20px;width:360px;"
      + "background:#fff;border:1px solid #ccc;box-shadow:0 4px 24px rgba(0,0,0,0.25);z-index:999999;"
      + "font-family:Arial,sans-serif;font-size:13px;padding:16px;border-radius:6px;";

    var entete = document.createElement("div");
    entete.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;";
    var titreEl = document.createElement("b");
    titreEl.style.fontSize = "15px";
    titreEl.textContent = titre;
    entete.appendChild(titreEl);
    var fermer = document.createElement("button");
    fermer.textContent = "✕";
    fermer.style.cssText = "border:none;background:none;font-size:16px;cursor:pointer;";
    fermer.onclick = function () { panneau.remove(); };
    entete.appendChild(fermer);
    panneau.appendChild(entete);

    var corps = document.createElement("p");
    corps.style.cssText = "color:#767676;margin:0;";
    corps.textContent = texte;
    panneau.appendChild(corps);

    document.body.appendChild(panneau);
  }

  // ─── Envoi des paquets ───
  // Historique des tentatives precedentes pour faire revenir un resultat
  // depuis Code.gs vers l'onglet LinkedIn (toutes bloquees en conditions
  // reelles le 2026-08-17) :
  //  1. window.open + window.opener.postMessage : LinkedIn coupe la
  //     relation window.opener entre la popup et l'onglet appelant
  //     (Cross-Origin-Opener-Policy) -- la requete part et Code.gs ecrit
  //     bien dans le Sheet, mais le message retour n'arrive jamais.
  //  2. JSONP (balise <script src="...&callback=...">) : LinkedIn bloque le
  //     chargement du script via sa Content-Security-Policy (script-src),
  //     la requete ne part meme pas.
  //  3. fetch/XHR : deja ecarte de longue date (connect-src, voir
  //     commentaire historique plus bas sur captureLot dans Code.gs).
  // Seule la navigation simple (window.open(url), sans jamais lire ni
  // ecouter de reponse) n'est bloquee par rien de tout ca -- c'est ce qui
  // reste utilisable pour ENVOYER, mais pas pour RECUPERER un resultat
  // depuis cet onglet. Solution (voir Code.gs, ONGLET_SESSIONS_LOG) : chaque
  // paquet ecrit son resultat dans un journal cote Sheet, identifie par
  // "session" (genere ci-dessous). Une derniere navigation ouvre la page de
  // resultats que Code.gs construit lui-meme (afficherResultatsSession) --
  // Marie regarde CETTE fenetre plutot qu'un panneau sur LinkedIn.
  function genererSession() {
    return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function envoyer() {
    // Persiste des maintenant (avant meme l'envoi reseau) : le but est
    // d'eviter de re-scroller ces conversations au prochain run, pas de
    // garantir que l'ecriture serveur a reussi -- si un fil n'a rien donne
    // de nouveau, le re-scanner plus tard ne changerait rien tant que Marie
    // n'a pas agi dessus autrement.
    nouvellesClefs.forEach(function (c) { dejaTraites[c] = true; });
    sauvegarderTraites(dejaTraites);

    if (conversations.length === 0) {
      afficherAvis("CRM — Réconciliation", ignoresDejaTraites > 0
        ? ignoresDejaTraites + " conversation(s) ignorée(s) — déjà traitées lors d'un run précédent."
        : "Aucune conversation détectée — les sélecteurs du bookmarklet ne correspondent probablement pas à la structure actuelle de la page, à corriger.");
      return;
    }
    // Taille de paquet limitee a 10 : chaque conversation embarque jusqu'a
    // 140 caracteres d'extrait, et l'appel part en GET (donnees dans l'URL,
    // pas en POST) -- avec des accents francais qui gonflent sous
    // encodeURIComponent, un paquet de 40 produit une URL de ~18000
    // caracteres, au-dela de ce que les serveurs Google acceptent en entete
    // de requete (erreur "400 -- Votre client a emis une demande mal
    // formee"). Avec 10, on reste a ~4600 caracteres.
    var TAILLE_PAQUET = 10;
    var paquets = [];
    for (var i = 0; i < conversations.length; i += TAILLE_PAQUET) paquets.push(conversations.slice(i, i + TAILLE_PAQUET));
    var session = genererSession();

    // Espacement entre paquets, releve de 2,5s a 15s le 2026-08-18 : a 2,5s,
    // sur un gros scan (140+ paquets), les requetes arrivaient plus vite que
    // matcherReponses ne pouvait les traiter (chacune lit tout Prospects,
    // ~2500 lignes, SOUS verrou cote Code.gs) -- la file d'attente grossissait
    // jusqu'a ce que des paquets attendent plus de 30s le verrou et echouent
    // completement ("Exception: Expiration de la demande de verrouillage"),
    // perdant les 10 conversations du paquet sans aucun signal clair pour
    // Marie. A 15s, l'espacement client depasse largement la duree d'une
    // execution serveur -- combine au timeout de verrou releve a 120s cote
    // Code.gs (voir matcherReponses), la file ne devrait plus jamais se
    // former. Marie prefere explicitement un scan lent (quitte a durer
    // jusqu'a ~1h sur un gros historique) plutot que rapide et partiel.
    var DELAI_ENTRE_PAQUETS = 15000;
    paquets.forEach(function (paquet, idx) {
      setTimeout(function () {
        var url = URL_BASE + "?action=matcherReponses&session=" + encodeURIComponent(session)
          + "&pwd=" + encodeURIComponent(pwd) + "&donnees=" + encodeURIComponent(JSON.stringify(paquet));
        window.open(url, "crmaime_paquet_" + idx);
      }, idx * DELAI_ENTRE_PAQUETS);
    });

    var delaiAbsents = paquets.length * DELAI_ENTRE_PAQUETS + 3000;
    setTimeout(function () {
      var urlAbsents = URL_BASE + "?action=verifierAbsents&session=" + encodeURIComponent(session)
        + "&pwd=" + encodeURIComponent(pwd);
      window.open(urlAbsents, "crmaime_absents");
    }, delaiAbsents);

    // Fenetre de resultats finale : delai genereux (40s apres le dernier
    // appel prevu) car on n'a plus aucun signal de fin d'execution cote
    // client (voir historique plus haut) -- matcherReponses peut prendre
    // 18-37s cote serveur. La page elle-meme invite a l'actualiser si le
    // compte semble bas (voir Code.gs, afficherResultatsSession).
    var delaiResultats = delaiAbsents + 40000;
    setTimeout(function () {
      var urlResultats = URL_BASE + "?action=voirResultatsSession&session=" + encodeURIComponent(session)
        + "&pwd=" + encodeURIComponent(pwd);
      window.open(urlResultats, "crmaime_resultats");
    }, delaiResultats);

    afficherAvis("CRM — Réconciliation en cours",
      conversations.length + " conversation(s) envoyée(s) au CRM"
      + (ignoresDejaTraites > 0 ? " (" + ignoresDejaTraites + " ignorée(s), déjà traitées)" : "") + "."
      + " La fenêtre de résultats s'ouvrira automatiquement dans ~" + Math.round(delaiResultats / 1000) + "s — ne ferme pas cet onglet d'ici là.");
  }

  var palier = 0;
  var conteneur = null;
  function etape() {
    collecter();
    if (palier >= PALIERS) {
      envoyer();
      return;
    }
    if (!conteneur) conteneur = conteneurListe();
    if (conteneur) conteneur.scrollBy(0, PAS); else window.scrollBy(0, PAS);
    palier++;
    setTimeout(etape, DELAI);
  }
  etape();
})();
