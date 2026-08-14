# catalog-svc

Catalog tooling for the storefront. Plain node, no build step, no database server — the store is a
JSON file under `data/`.

    node seed.js                    load the starter catalog
    node report.js                  list items with their category and price
    node update.js <id> <label>     rename an item
    node export.js [out.csv]        export live items to CSV (--all to include inactive)

Item ids in `data/catalog.json` are referenced by the warehouse and the storefront, and by finance
reports for past months. Never renumber them, and retire an item by setting `active: false` rather
than removing the row.

Configuration is in `config.json`.
