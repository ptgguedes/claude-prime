# Worker « outils-api »

Enregistre dans R2 les modifications de fiches et les commentaires de `outils.html`.
Les tableaux d'origine restent dans `outils.html` : si le Worker est arrêté, la page s'affiche comme avant.

## Ce que fait le Worker

| Route | Rôle | Protégée par `EDIT_KEY` |
|---|---|---|
| `GET /state` | renvoie les fiches modifiées et tous les commentaires | non |
| `PUT /tools/:id` | remplace la fiche d'un outil (`a-0`… source A, `b-0`… source B) | oui |
| `DELETE /tools/:id` | rétablit la fiche d'origine (les commentaires restent) | oui |
| `POST /tools/:id/comments` | ajoute un commentaire (pseudo facultatif, 1 000 caractères) | non |

Tout est stocké dans un seul objet R2, `state.json`. Les écritures sont conditionnelles et rejouées en cas de conflit.
Toute écriture doit venir d'un site listé dans `ALLOWED_ORIGINS`. Les identifiants `a-N` / `b-N` suivent l'ordre des
tableaux `A` et `B` d'`outils.html` : n'insérez pas d'outil au milieu, ajoutez-les à la fin.

## Réglages dans Cloudflare (à faire une fois)

1. **R2** : activer R2, puis créer un bucket privé nommé `outils-data` (ou un autre nom, à reporter dans `wrangler.toml`).
2. **Worker** : créer le Worker `outils-api` et y déployer `index.js`.
3. **Liaison R2** : Worker > Settings > Bindings > R2 bucket, variable `BUCKET`, bucket `outils-data`.
4. **Variable `ALLOWED_ORIGINS`** : adresses des sites autorisés, séparées par des virgules (valeur par défaut dans `wrangler.toml`).
5. **Secret `EDIT_KEY`** (recommandé) : mot de passe demandé pour modifier ou rétablir une fiche. Sans lui, tout visiteur peut modifier les fiches.
6. Copier l'adresse du Worker (`https://outils-api.<compte>.workers.dev`) dans la ligne `var API="";` d'`outils.html`.

### Déploiement avec la ligne de commande (facultatif)

```
cd worker
npx wrangler login
npx wrangler r2 bucket create outils-data
npx wrangler secret put EDIT_KEY      # vous tapez le mot de passe, il n'est écrit nulle part
npx wrangler deploy
```

Attention : `wrangler deploy` remplace les variables déclarées dans `wrangler.toml` (`ALLOWED_ORIGINS`) par celles du fichier.

## Test en local (sans compte Cloudflare)

```
cd worker
npx wrangler dev --local --var EDIT_KEY:essai
```

R2 est alors simulé sur votre machine.
