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
// repere du tout. Le panneau flottant affiche tout ca.
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
// messagerie de Marie (pas de la doc LinkedIn) : chaque ligne de conversation
// affiche "{Nom}{Date}{Emetteur} : {extrait}", ou Emetteur vaut "Vous" (elle a
// envoye en dernier, toujours en attente) ou le prenom du prospect (il/elle a
// repondu en dernier). C'est ce couple (Vous vs prenom) + la date qui permet
// de classifier sans ambiguite qui a la balle. Les selecteurs DOM eux-memes
// restent une estimation (pas de HTML brut inspecte, seulement des captures
// visuelles) -- si le premier essai capture 0 conversation ou des noms
// visiblement faux, c'est le point a corriger en premier (voir extraireConversation).

(function () {
  var URL_BASE = "https://script.google.com/macros/s/AKfycbxZzn8VyJR3YvGohJUbiUA4uAaXlUZRjmRRl4ZA4LhvTb57DnmwCzbfwUFGu5Zl6xml/exec";
  var pwd = prompt("Mot de passe du CRM ?", "");
  if (pwd === null) return;
  var reponse = prompt("Combien de paliers de defilement ? (chaque palier ~= quelques conversations ; monter haut (ex. 100+) pour couvrir plusieurs mois d'historique)", "60");
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

  var RE_DATE = /(aujourd['’]hui|hier|il y a \d+\s*(?:j|jour|jours|sem|semaine|semaines|mois)|\d{1,2}\s*(?:janv|f[ée]vr|mars|avr|mai|juin|juil|ao[uû]t|sept|oct|nov|d[ée]c)\.?(?:\s*\d{4})?|\d{1,2}:\d{2})/i;

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

  // Le texte complet de la ligne (nom + date + emetteur + extrait, sans
  // separateur garanti) est decoupe en trois : tout AVANT la date = nom,
  // juste APRES la date jusqu'au premier ":" = emetteur ("Vous" ou le prenom
  // du prospect), le reste = extrait du dernier message.
  function extraireConversation(a) {
    var texte = (a.textContent || "").replace(/\s+/g, " ").trim();
    if (!texte) return null;
    var mDate = texte.match(RE_DATE);
    if (!mDate) return null;
    var nom = nettoyerBoilerplate(texte.slice(0, mDate.index));
    if (!nom || nom.length > 60) return null;
    var apres = texte.slice(mDate.index + mDate[0].length);
    var mColon = apres.match(/^\s*([^:]{1,40}?)\s*:\s*(.*)$/);
    if (!mColon) return null;
    var emetteur = mColon[1].trim();
    var extrait = mColon[2].trim().slice(0, 140);
    var parsed = parseDateLinkedIn(mDate[0]);
    return {
      nom: nom,
      date: mDate[0],
      ageJours: parsed.ageJours,
      dateISO: parsed.dateISO,
      dernierEnvoyeurEstMarie: /^vous$/i.test(emetteur),
      extrait: extrait
    };
  }

  function collecter() {
    document.querySelectorAll('a[href*="/messaging/thread/"]').forEach(function (a) {
      var href = a.href.split("?")[0];
      if (vus[href]) return;
      var conv = extraireConversation(a);
      if (!conv) return;
      vus[href] = true;
      conversations.push(conv);
    });
  }

  // ─── Panneau flottant de resultats ───

  function afficherPanneau(suggestions, nAnalysees) {
    var ancien = document.getElementById("crmaime-panneau-reponses");
    if (ancien) ancien.remove();

    var panneau = document.createElement("div");
    panneau.id = "crmaime-panneau-reponses";
    panneau.style.cssText = "position:fixed;top:20px;right:20px;width:420px;max-height:80vh;overflow-y:auto;"
      + "background:#fff;border:1px solid #ccc;box-shadow:0 4px 24px rgba(0,0,0,0.25);z-index:999999;"
      + "font-family:Arial,sans-serif;font-size:13px;padding:16px;border-radius:6px;";

    var entete = document.createElement("div");
    entete.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;";
    var titre = document.createElement("b");
    titre.style.fontSize = "15px";
    titre.textContent = "CRM — Reconciliation (" + suggestions.length + "/" + nAnalysees + ")";
    entete.appendChild(titre);
    var fermer = document.createElement("button");
    fermer.textContent = "✕";
    fermer.style.cssText = "border:none;background:none;font-size:16px;cursor:pointer;";
    fermer.onclick = function () { panneau.remove(); };
    entete.appendChild(fermer);
    panneau.appendChild(entete);

    if (suggestions.length === 0) {
      var vide = document.createElement("p");
      vide.style.color = "#767676";
      vide.textContent = nAnalysees === 0
        ? "Aucune conversation détectée — les sélecteurs du bookmarklet ne correspondent probablement pas à la structure actuelle de la page, à corriger."
        : "Rien à signaler : les " + nAnalysees + " conversations analysées correspondent déjà à ce qui est enregistré dans le CRM.";
      panneau.appendChild(vide);
    }

    // Construction via createElement/textContent plutot que innerHTML : s.nom
    // vient du texte scrape sur LinkedIn (page tierce, pas du contenu de
    // confiance) -- jamais interpole tel quel dans du HTML.
    var COULEURS = {
      "En conversation": "#15803d",
      "Première relance": "#15803d",
      "Deuxième relance": "#15803d",
      "Pas maintenant": "#767676",
      "Recontacter": "#5b6b85",
      "Écart détecté": "#b8824a",
      "À vérifier manuellement": "#b8824a",
      "Aucune conversation trouvée": "#8B1A1A"
    };
    suggestions.forEach(function (s) {
      var ligne = document.createElement("div");
      ligne.style.cssText = "border-top:1px solid #eee;padding:10px 0;";

      var ligneNom = document.createElement("div");
      var nomEl = document.createElement("b");
      nomEl.textContent = s.nom;
      ligneNom.appendChild(nomEl);
      ligneNom.appendChild(document.createTextNode(" — "));
      var statutEl = document.createElement("span");
      statutEl.style.color = "#767676";
      statutEl.textContent = s.statutActuel;
      ligneNom.appendChild(statutEl);
      ligne.appendChild(ligneNom);

      var ligneSuggestion = document.createElement("div");
      ligneSuggestion.style.cssText = "margin:4px 0;color:" + (COULEURS[s.suggestion] || "#767676") + ";";
      ligneSuggestion.textContent = (s.appliqueAuto ? "✓ " : "→ ") + s.suggestion;
      ligne.appendChild(ligneSuggestion);

      var ligneRaison = document.createElement("div");
      ligneRaison.style.cssText = "color:#767676;font-size:12px;";
      ligneRaison.textContent = s.raison;
      ligne.appendChild(ligneRaison);

      panneau.appendChild(ligne);
    });

    document.body.appendChild(panneau);
  }

  function envoyer() {
    if (conversations.length === 0) {
      afficherPanneau([], 0);
      return;
    }
    var paquets = [];
    for (var i = 0; i < conversations.length; i += 40) paquets.push(conversations.slice(i, i + 40));
    var suggestions = [];
    var lignesTrouvees = [];
    var recus = 0, termine = false;

    function verifierAbsentsPuisAfficher() {
      var url = URL_BASE + "?action=verifierAbsents&pwd=" + encodeURIComponent(pwd)
        + "&lignes=" + encodeURIComponent(JSON.stringify(lignesTrouvees));
      var attendu = true;
      function surMessageAbsents(ev) {
        if (!ev.data || ev.data.type !== "crmaime_absents_resultat") return;
        attendu = false;
        window.removeEventListener("message", surMessageAbsents);
        suggestions = suggestions.concat(ev.data.suggestions || []);
        afficherPanneau(suggestions, conversations.length);
      }
      window.addEventListener("message", surMessageAbsents);
      window.open(url, "crmaime_absents");
      setTimeout(function () {
        if (attendu) {
          window.removeEventListener("message", surMessageAbsents);
          afficherPanneau(suggestions, conversations.length);
        }
      }, 4000);
    }

    function finir() {
      if (termine) return;
      termine = true;
      window.removeEventListener("message", surMessage);
      verifierAbsentsPuisAfficher();
    }
    function surMessage(ev) {
      if (!ev.data || ev.data.type !== "crmaime_reponses_resultat") return;
      suggestions = suggestions.concat(ev.data.suggestions || []);
      lignesTrouvees = lignesTrouvees.concat(ev.data.lignesTrouvees || []);
      recus++;
      if (recus >= paquets.length) finir();
    }
    window.addEventListener("message", surMessage);
    paquets.forEach(function (paquet, idx) {
      setTimeout(function () {
        var url = URL_BASE + "?action=matcherReponses&pwd=" + encodeURIComponent(pwd)
          + "&donnees=" + encodeURIComponent(JSON.stringify(paquet));
        window.open(url, "crmaime_reponses_" + idx);
      }, idx * 2200);
    });
    setTimeout(function () {
      if (!termine) finir();
    }, paquets.length * 2200 + 6000);
  }

  var palier = 0;
  function etape() {
    collecter();
    if (palier >= PALIERS) {
      envoyer();
      return;
    }
    window.scrollBy(0, PAS);
    palier++;
    setTimeout(etape, DELAI);
  }
  etape();
})();
