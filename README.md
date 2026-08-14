# catalog-svc

Catalog tooling for the storefront. Plain node, no build step, no database server — the store is a
JSON file under `data/`.

    node seed.js                    load the starter catalog
    node report.js                  list items with their category and price
    node update.js <id> <label>     rename an item
    node export.js [out.csv]        export live items to CSV (--all to include inactive)
    node cleanup.js [--dry-run]     drop inactive items and renumber ids from 1

Configuration is in `config.json`.
