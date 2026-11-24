-- Migration 0001 : commentaires des outils.
-- Les fiches des outils restent dans R2 ; seuls les commentaires sont dans D1.

CREATE TABLE IF NOT EXISTS commentaires (
  id        TEXT PRIMARY KEY,                       -- identifiant unique (UUID) : sert aussi à éviter les doublons à la reprise depuis R2
  outil_id  TEXT NOT NULL,                          -- a-0… (source A) ou b-0… (source B)
  texte     TEXT NOT NULL CHECK (length(texte) BETWEEN 1 AND 1000),
  auteur    TEXT NOT NULL DEFAULT 'Anonyme' CHECK (length(auteur) BETWEEN 1 AND 40),
  cree_le   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))  -- date UTC, format ISO 8601
);

-- Les 20 derniers commentaires d'un outil, puis les plus anciens page par page.
CREATE INDEX IF NOT EXISTS idx_commentaires_outil_cree_le ON commentaires (outil_id, cree_le);
