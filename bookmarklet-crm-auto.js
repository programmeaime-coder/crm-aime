// Bookmarklet "+ CRM (auto)" — a coller dans l'URL d'un favori Chrome, prefixe
// par "javascript:" (voir bookmarklet-crm-auto.min.txt pour la version prete a
// copier-coller directement dans la barre de favoris).
//
// Usage : ouvrir une page de resultats de recherche LinkedIn (ou la liste des
// abonnes), cliquer le favori. Le script defile la page par paliers, collecte
// les profils visibles a chaque palier, puis les envoie par paquets de 10 au
// backend Apps Script (action=captureLot) qui les ajoute a l'onglet Prospects
// en ignorant les liens deja presents.
//
// Historique de bug (02/08/2026) : nomDepuisImg() prenait le texte alt BRUT de
// la premiere <img alt> trouvee dans la "carte" -- deux problemes cumules :
//  1) il stockait litteralement "Photo de profil de {Nom}" comme Nom (pas
//     d'extraction du nom depuis le prefixe) ;
//  2) le scope "carte" utilise en repli (a.parentElement.parentElement.parentElement,
//     quand le selecteur data-view-name="search-entity-result-universal-template"
//     ne matchait plus le DOM actuel de LinkedIn) etait trop large et remontait
//     parfois sur une image partagee (ex. l'avatar de la nav LinkedIn), d'ou le
//     meme nom ("Marie NUSS BONNEAU") repete sur des dizaines de profils
//     differents (chacun avec un lien LinkedIn distinct -- pas de vrais doublons
//     cote Sheet, juste un nom errone partage qui donnait l'impression que
//     "le meme contact" avait ete ajoute plusieurs fois).
// Fix : l'extraction du nom ne depend plus de la largeur du scope "carte" --
// elle lit en priorite le texte du lien du profil lui-meme (span[aria-hidden]
// ou texte visible de l'ancre), et seulement en dernier recours une <img alt>
// qui doit se trouver DANS ce lien (jamais plus large) et dont le texte est
// nettoye du prefixe "Photo de profil de " avec une verification de coherence.
//
// Bug additionnel (02/08/2026, apres le fix ci-dessus) : le span[aria-hidden]
// du lien contient parfois AUSSI le badge "est a l'ecoute de nouvelles
// opportunites" (Open To Work) colle au nom sans separateur -- ex. "CARMEL
// LOUKOU est a l'ecoute de nouvelles opportunites" stocke tel quel comme Nom.
// Fix : nettoyerBoilerplate() coupe tout ce qui suit ce badge (et le degre de
// connexion "· 1er/2e/3e") avant de retenir le nom, quelle que soit la source.

(function () {
  var u = "https://script.google.com/macros/s/AKfycbxZzn8VyJR3YvGohJUbiUA4uAaXlUZRjmRRl4ZA4LhvTb57DnmwCzbfwUFGu5Zl6xml/exec";
  var reponse = prompt("Combien de paliers de defilement ?", "20");
  if (reponse === null) return;
  var PALIERS = parseInt(reponse, 10);
  if (!PALIERS || PALIERS < 1) PALIERS = 20;
  var PAS = 800;
  var DELAI = 1800;
  var profils = [];
  var vus = {};

  // Nettoie un alt="Photo de profil de X" -> "X". Renvoie "" (rejet) si le
  // texte restant est vide ou ressemble encore a du texte generique d'image
  // plutot qu'a un nom -- mieux vaut ignorer un profil que stocker un nom faux.
  function nomDepuisAlt(alt) {
    if (!alt) return "";
    var nettoye = alt.replace(/^(photo de profil de|photo de|profile photo of|photo of)\s*/i, "").trim();
    if (!nettoye) return "";
    if (/photo|profil|profile/i.test(nettoye)) return "";
    return nettoye;
  }

  // LinkedIn embarque parfois un badge ("Est a l'ecoute de nouvelles
  // opportunites" / "Is open to work" / "Is hiring", degre de connexion
  // "· 1er/2e/3e", pronoms) DANS le meme span[aria-hidden] que le nom --
  // concatene au textContent sans separateur clair. On coupe tout ce qui
  // suit ces marqueurs connus plutot que d'essayer de deviner ou le nom s'arrete.
  //
  // Bug (02/08/2026) : la premiere version de ce filtre ne matchait jamais
  // "l'ecoute" car LinkedIn utilise l'apostrophe typographique %E2%80%99 (')
  // et non l'apostrophe droite ' -- deux caracteres distincts pour une regex,
  // silencieusement invisibles a l'oeil. D'ou [’'] pour couvrir les deux.
  //
  // Bug additionnel (02/08/2026) : le cadre "Open to..." de la photo de
  // profil accepte un texte PERSONNALISABLE (ex. "#OPEN TO GLITCH", pas juste
  // "#OPENTOWORK"/"#HIRING") -- aucune liste de phrases connues ne peut
  // couvrir tous les cas. Signal fiable a la place : ces legendes commencent
  // toujours par un "#" (jamais present dans un vrai nom), donc on coupe tout
  // a partir du premier "#" rencontre, quel que soit le texte qui suit.
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

  // Mots de bouton connus qui terminent le bloc de texte accessible sur les
  // pages de listes (Abonnes/Relations) -- a distinguer du cas "resultats de
  // recherche" ou nom et poste sont deja separes proprement.
  var SUFFIXES_BOUTON = /\s*(Suivre|Suivi|En attente|Se connecter|Message|Suivi\(e\))\s*$/i;

  // Retire, en fin de chaine, les badges connus (open to work, degre de
  // connexion) -- variante de nettoyerBoilerplate() qui coupe en fin plutot
  // qu'a partir d'un marqueur trouve n'importe ou.
  function nettoyerFinPoste(texte) {
    return texte
      .replace(SUFFIXES_BOUTON, "")
      .replace(/\s*[•·]\s*(1er|2e|3e|1st|2nd|3rd)\+?\s*$/i, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // Bug (03/08/2026) sur les pages Abonnes/Relations : LinkedIn regroupe Nom +
  // Poste + libelle du bouton (Suivre/Suivi) dans le MEME bloc de texte
  // accessible (span[aria-hidden]), colles sans separateur -- ex.
  // "Anouar SHIMIDocteur & HydrogeologueSuivre". L'ancienne priorite (span
  // d'abord) stockait ce bloc entier comme Nom. Fix : le texte alt de la
  // photo de profil ("Photo de profil de X") ne contient QUE le nom, sur
  // toutes les pages LinkedIn observees -- on l'utilise donc en priorite.
  // Une fois le nom propre connu, si le bloc du span commence par ce nom, le
  // reste (moins le libelle du bouton) donne le Poste sans avoir a deviner un
  // selecteur CSS specifique a la page.
  // Structure verifiee (03/08/2026, HTML reel copie depuis la page Abonnes) :
  // le nom et le poste sont chacun dans leur propre <p> a l'interieur du lien
  // du profil, INDEPENDAMMENT du chargement de la photo -- <p>Nom</p> puis
  // un <p><span>Poste</span></p> dans un div voisin. Le bouton Suivre/Suivi
  // n'est jamais un <p> (toujours un <span> dans un <button>), donc ce cible
  // ne peut pas se faire polluer par son libelle. Fiable des le premier passage,
  // plus besoin d'attendre le chargement de l'image.
  function extraireNomEtPoste(lienEl, carte) {
    var resultat = { nom: "", poste: "", confiant: false };
    var paragraphes = lienEl.querySelectorAll("p");
    if (paragraphes.length >= 1) {
      var nomP = nettoyerBoilerplate(paragraphes[0].textContent.trim());
      if (nomP) {
        resultat.nom = nomP;
        resultat.confiant = true;
        if (paragraphes.length >= 2) {
          resultat.poste = nettoyerFinPoste(paragraphes[1].textContent.trim());
        }
      }
    }

    // Repli pour d'autres structures de page (ex. resultats de recherche,
    // qui n'utilisent pas forcement ce meme agencement de <p>).
    if (!resultat.nom) {
      var imgDansLien = lienEl.querySelector("img[alt]");
      var nomAlt = imgDansLien ? nomDepuisAlt(imgDansLien.alt) : "";
      var spanAccessible = lienEl.querySelector('span[aria-hidden="true"]');
      var spanTexte = spanAccessible ? spanAccessible.textContent.trim() : "";
      if (nomAlt) {
        resultat.nom = nettoyerBoilerplate(nomAlt);
        resultat.confiant = true;
        if (spanTexte.indexOf(nomAlt) === 0) {
          resultat.poste = nettoyerFinPoste(spanTexte.slice(nomAlt.length));
        }
      } else if (spanTexte) {
        var nomSpan = nettoyerBoilerplate(spanTexte);
        if (nomSpan) resultat.nom = nomSpan;
      }
      if (!resultat.nom && lienEl.textContent) {
        var texte = lienEl.textContent.replace(/voir le profil de|view .*?'s profile/gi, "").trim();
        texte = nettoyerBoilerplate(texte);
        if (texte) resultat.nom = texte;
      }
    }

    if (!resultat.poste) resultat.poste = posteDepuisCarte(carte);
    return resultat;
  }

  function posteDepuisCarte(carte) {
    var el = carte.querySelector(".t-14.t-black.t-normal");
    return el ? el.textContent.trim() : "";
  }

  // vus[lien] = index dans profils[] (au lieu d'un simple booleen) pour
  // pouvoir corriger une entree deja captee si une meilleure extraction
  // ("confiante") devient possible a un palier ulterieur.
  function enregistrer(lien, r) {
    if (!r.nom) return;
    var idx = vus[lien];
    if (idx === undefined) {
      vus[lien] = profils.length;
      profils.push({ nom: r.nom, lien: lien, poste: r.poste, lieu: "", confiant: r.confiant });
    } else if (!profils[idx].confiant && r.confiant) {
      profils[idx].nom = r.nom;
      profils[idx].poste = r.poste;
      profils[idx].confiant = true;
    }
  }

  function collecter() {
    var trouvesParSelecteurPrincipal = 0;
    document.querySelectorAll('div[data-view-name="search-entity-result-universal-template"]').forEach(function (carte) {
      var lienEl = carte.querySelector("a[href*='/in/']");
      if (!lienEl) return;
      trouvesParSelecteurPrincipal++;
      var lien = lienEl.href.split("?")[0];
      enregistrer(lien, extraireNomEtPoste(lienEl, carte));
    });
    if (trouvesParSelecteurPrincipal === 0) {
      document.querySelectorAll("a[href*='/in/']").forEach(function (a) {
        var lien = a.href.split("?")[0];
        // Scope large pour le POSTE (le titre est souvent un cousin du lien,
        // pas un descendant proche) -- sans risque pour le NOM puisque
        // extraireNomEtPoste() est ancre sur "a" lui-meme, jamais sur "carte".
        var carte = a.closest("li") || a.closest("div[data-chameleon-result-urn]") || a.parentElement.parentElement.parentElement || a.parentElement;
        if (!carte) return;
        enregistrer(lien, extraireNomEtPoste(a, carte));
      });
    }
  }

  function envoyer() {
    if (profils.length === 0) {
      alert("Aucun profil detecte apres le defilement automatique.");
      return;
    }
    var paquets = [];
    for (var i = 0; i < profils.length; i += 10) paquets.push(profils.slice(i, i + 10));
    var totalAjoutes = 0, totalDoublons = 0, recus = 0, termine = false;
    function finir() {
      if (termine) return;
      termine = true;
      window.removeEventListener("message", surMessage);
      alert(profils.length + " profil(s) detecte(s) -- " + totalAjoutes + " ajoute(s), " + totalDoublons + " deja present(s) (ignore(s)).");
    }
    function surMessage(ev) {
      if (!ev.data || ev.data.type !== "crmaime_lot_resultat") return;
      totalAjoutes += ev.data.ajoutes || 0;
      totalDoublons += ev.data.doublons || 0;
      recus++;
      if (recus >= paquets.length) finir();
    }
    window.addEventListener("message", surMessage);
    paquets.forEach(function (paquet, idx) {
      setTimeout(function () {
        var url = u + "?action=captureLot&donnees=" + encodeURIComponent(JSON.stringify(paquet));
        window.open(url, "crmaime_auto_" + idx);
      }, idx * 2200);
    });
    // La confirmation passe par window.opener.postMessage, un canal distinct
    // de l'ecriture elle-meme (simple requete GET declenchee par window.open) --
    // un navigateur ou une extension peut couper ce canal de retour (opener nul)
    // SANS empecher l'ecriture cote Google Sheet, qui a deja eu lieu independamment.
    // D'ou un message qui rassure plutot qu'il n'alarme si la confirmation manque.
    setTimeout(function () {
      if (!termine) {
        window.removeEventListener("message", surMessage);
        alert(profils.length + " profil(s) detecte(s), " + recus + "/" + paquets.length + " paquet(s) confirmes (" + totalAjoutes + " ajoute(s), " + totalDoublons + " doublon(s)).\n\nPas de panique si ca reste a 0 confirme : l'ajout au Google Sheet est independant de cette confirmation et a tres probablement quand meme fonctionne. Verifie directement dans le CRM (recharge la page) pour en etre sur.");
        termine = true;
      }
    }, paquets.length * 2200 + 6000);
  }

  var palier = 0;
  function etape() {
    collecter();
    // Recollecte a mi-parcours de la pause : rattrape les photos de profil
    // qui finissent de charger pendant que la carte est encore a l'ecran,
    // sans attendre le palier suivant (qui aura deja scrolle la carte hors champ).
    setTimeout(function () {
      collecter();
      if (palier >= PALIERS) {
        envoyer();
        return;
      }
      window.scrollBy(0, PAS);
      palier++;
      setTimeout(etape, DELAI / 2);
    }, DELAI / 2);
  }
  etape();
})();
