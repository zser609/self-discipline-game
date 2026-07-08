const fs = require("fs");
const path = require("path");
const file = path.join(__dirname, "docs", "index.html");
let c = fs.readFileSync(file, "utf-8");
c = c.replace('<script type="module" crossorigin>', "<script>");
c = c.replace(/ crossorigin/g, "");
fs.writeFileSync(file, c);
console.log("✅ Fixed: removed type=module and crossorigin");
