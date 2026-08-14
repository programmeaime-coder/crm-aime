// Bookmarklet "CRM Réponses (auto)" — a coller dans l'URL d'un favori Chrome,
// prefixe par "javascript:" (voir bookmarklet-crm-reponses.min.txt pour la
// version prete a copier-coller directement dans la barre de favoris).
//
// Usage : ouvrir linkedin.com/messaging/, cliquer le favori, entrer le mot de
// passe du CRM une fois. Le script defile la liste des conversations par
// paliers, lit pour chacune le nom, la date du dernier message et QUI l'a
// envoye en dernier (Marie ou le prospect), envoie ca par lots au backend
// Apps Script (action=matcherReponses) qui compare a l'onglet Prospects. Une
// fois tous les paquets traites, un dernier appel (action=verifierAbsents)
// signale les prospects "en attente" dont aucun fil n'a ete repere du tout.
// Le panneau flottant affiche tout ca. Cas "reponse recue" (signal fiable,
// valide par Marie) : le Statut passe automatiquement a "En conversation",
// deja fait au moment ou le panneau s'affiche. Les autres cas (ecarts,
// absences) restent purement informatifs -- a verifier a la main dans
// l'onglet Prospects, rien n'est ecrit pour ceux-la.
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
  var reponse = prompt("Combien de paliers de defilement ?", "15");
  if (reponse === null) return;
  var PALIERS = parseInt(reponse, 10);
  if (!PALIERS || PALIERS < 1) PALIERS = 15;
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

  var RE_DATE = /(aujourd['’]hui|hier|il y a \d+\s*(?:j|jour|jours|sem|semaine|semaines|mois)|\d{1,2}\s*(?:janv|f[ée]vr|mars|avr|mai|juin|juil|ao[uû]t|sept|oct|nov|d[ée]c)\.?|\d{1,2}:\d{2})/i;

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
    return {
      nom: nom,
      date: mDate[0],
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
      "Écart détecté": "#b8824a",
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
