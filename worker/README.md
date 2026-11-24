# Worker « outils-api »

Fiches des outils → **R2** (liaison `DATA`). Commentaires → **D1** (liaison `DB`, base `projet-db`).
Aucun secret dans ce dossier.

## Routes
| Route | Rôle |
|---|---|
| `GET /state` | fiches modifiées + nombre de commentaires par outil |
| `PUT` / `DELETE /tools/:id` | modifier / rétablir une fiche (mot de passe `EDIT_KEY` s'il existe) |
| `GET /api/outils/:id/commentaires` | les 20 derniers ; `?avant=<curseur>` pour les plus anciens (`suivant` dans la réponse) |
| `POST /api/outils/:id/commentaires` | ajouter un commentaire (`author`, `text`) |
| `POST /api/admin/reprise-r2` | reprise unique depuis R2 (voir plus bas) |

Toutes les requêtes SQL passent par `prepare().bind()`. Tâche planifiée : chaque jour à 03:17 UTC, suppression des commentaires de plus de `RETENTION_MONTHS` (12) mois.

## À régler par vous
1. `wrangler.jsonc` : remplacer `A_COMPLETER_ID_DE_LA_BASE_D1` par l'identifiant de `projet-db` (Cloudflare > D1) ; vérifier `bucket_name` (R2).
2. GitHub > Settings > Secrets > Actions : `CLOUDFLARE_API_TOKEN` (droits Workers Scripts:Edit + D1:Edit) et `CLOUDFLARE_ACCOUNT_ID`.
3. Cloudflare > Worker > Settings : secret `EDIT_KEY` (facultatif pour les fiches, **obligatoire** pour la reprise R2).
4. `outils.html` : renseigner `var API` avec l'adresse du Worker.

Le workflow `.github/workflows/deploy-worker.yml` applique `wrangler d1 migrations apply projet-db --remote` puis déploie.

## Reprise unique des anciens commentaires (R2 → D1) — NON lancée
Les anciens commentaires de `state.json > comments` ne sont jamais supprimés de R2. La reprise utilise l'identifiant du commentaire (`INSERT OR IGNORE`) : la relancer ne crée pas de doublon ; les commentaires déjà plus vieux que 12 mois sont ignorés.

    # 1. simulation (n'écrit rien)
    curl -X POST https://<worker>/api/admin/reprise-r2 -H "X-Edit-Key: <EDIT_KEY>" -H "Content-Type: application/json" -d '{}'
    # 2. reprise réelle, seulement après votre accord
    curl -X POST https://<worker>/api/admin/reprise-r2 -H "X-Edit-Key: <EDIT_KEY>" -H "Content-Type: application/json" -d '{"confirmer":true}'

## Test local (sans compte Cloudflare)
    npx wrangler d1 migrations apply projet-db --local --persist-to /tmp/p
    npx wrangler dev --local --persist-to /tmp/p --test-scheduled --var EDIT_KEY:test
    curl "localhost:8787/__scheduled?cron=17+3+*+*+*"   # lance la purge
