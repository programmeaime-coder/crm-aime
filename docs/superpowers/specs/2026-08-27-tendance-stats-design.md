# Indicateur de tendance dans l'onglet Stats

## Objectif
Sous certains chiffres de l'onglet Stats, afficher discrètement une petite flèche (↑/↓/→) + un pourcentage de variation par rapport à il y a une semaine. Doit rester très compact (pas de gain de hauteur notable sur les tuiles).

## Périmètre
1. **Ligne "Envoyés cette semaine"** : ajout d'une 4e tuile "Recontacts" (compte `dateEnvoiRecontacte` cette semaine, même logique que les 3 tuiles existantes). Comparaison = semaine en cours (lundi→aujourd'hui) vs semaine dernière complète (lundi→dimanche), calculée directement depuis les dates déjà stockées par prospect — aucun stockage supplémentaire nécessaire. Tuiles resserrées (padding/min-width réduits) pour que les 4 tiennent sur une seule ligne.
2. **Les 5 KPI principaux en haut** (Prospects en base, Contactés, Taux de réponse global, Réponses → appel, Appels réservés/contactés) : ce sont des totaux cumulés, pas des compteurs hebdo. La comparaison se fait entre la valeur actuelle et une reconstitution de la valeur telle qu'elle était il y a 7 jours, à partir des dates déjà enregistrées par prospect (dateAjout, date1erMessage, dateReponse, dateAppelDecouverte) plutôt qu'un instantané mis en cache navigateur — fonctionne dès le premier jour, identique quel que soit l'appareil.
   - Approximation assumée : pour les rares fiches sans date fiable (ex. import historique sans `date1erMessage`), on les considère comme déjà comptées "avant" plutôt que de les exclure — évite de gonfler artificiellement la progression affichée à cause d'un simple trou de saisie.

## Calcul du pourcentage
`pct = round((valeurActuelle - valeurIlYA7j) / valeurIlYA7j * 100)`
- Si la valeur d'il y a 7 jours est indéterminable (ratio 0/0) → pas d'indicateur affiché.
- Si elle vaut 0 mais que la valeur actuelle est positive → flèche seule, sans pourcentage (division par zéro).
- Si égal → flèche neutre "→".

## Visuel
Petite ligne sous le `stat__label` existant, ~9px, discrète :
- ↑ vert (`--success`) si hausse
- ↓ bordeaux (`--bordeaux`) si baisse
- → gris (`--text-muted`) si stable

## Hors périmètre
- Pas de retouche des couleurs/légende du graphique funnel (déjà noté ailleurs comme à refaire séparément).
- Pas de déploiement/push tant que la direction n'est pas validée en local.
