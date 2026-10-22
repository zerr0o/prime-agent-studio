# Reprise expérimentale de Rust après redémarrage

[English](en/rust-recovery.md) · [Moteur natif](rust-runtime.md) · [Pont des outils Studio](rust-studio-tools.md)

Cette proposition dépendante reprend les exécutions Rust interrompues après le redémarrage de Studio. Elle repose sur le moteur natif et son pont d'outils. Elle ne reprend pas les anciens objectifs sans lien et ne rejoue pas le prompt utilisateur initial. Cette couche remplace l'absence de reprise du moteur de base ; les autres refus de fonctions incompatibles restent actifs.

Avant d'admettre un prompt, Studio enregistre l'exécution dans un journal privé `goal-recovery.json` dans son dossier de données. Après redémarrage, il tente chaque exécution admissible une fois avec une continuation de service visible. Il revérifie la session, le projet, l'identité de l'objectif, le budget d'origine, la file inactive et les préférences actuelles de modèle/réflexion. Les exécutions arrêtées/terminées, projets retirés, sessions archivées ou enfants, objectifs effacés, inactifs ou épuisés sont exclus. Un journal corrompu bloque la reprise. L'arrêt attend les écritures de métadonnées et du stockage des sessions.

La création native peut être acquittée avant que l'adoption d'un grand historique ne restaure l'objectif. La reprise effectue d'abord une lecture routée vers le worker, puis attend au maximum 30 secondes que l'état vide canonique se stabilise. Un objectif modifié/en pause ou une session occupée est refusé immédiatement. L'admissibilité est revérifiée juste avant le prompt de continuation. Les compteurs ne sont pas remis à zéro et la reprise n'accorde aucune nouvelle autorisation. La continuation demande de réconcilier les opérations en cours sans répéter les effets terminés ou ambigus.

Les exécutions sans objectif exigent une vérification native explicite d'objectif nul. La trace d'un objectif effacé n'est pas assimilée à une exécution ordinaire interrompue. Stop supprime l'admissibilité du journal avant l'annulation ; une admission utilisateur simultanée ne peut pas créer un doublon de reprise. Les effets non confirmés ne sont pas répétés aveuglément.

Exécutez `node --test test/goal-recovery.test.mjs test/server-goal-recovery.test.mjs test/rust-goal-recovery.test.mjs` pour le journal, le cycle HTTP et l'adaptateur natif. `node scripts/rust-recovery-canary.mjs CHEMIN_ABSOLU_DU_BINAIRE` vérifie l'adoption de 4 000 lignes synthétiques dans un daemon réel isolé, intercepte le prompt avant inférence et vérifie les compteurs inchangés. Ce dernier nécessite un exécutable compatible et ne teste pas un tour de modèle.

Cette proposition reste un brouillon. Ce candidat n'a pas de preuve fraîche de libération des verrous/réouverture Windows ni de fournisseur réel. Les tests isolés ne prouvent pas la reprise Windows avec le binaire public actuel, l'identité des enfants de bout en bout ou la parité des extensions Studio sous Rust.
