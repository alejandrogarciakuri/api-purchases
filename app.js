const express = require("express");
const app = express();
require("dotenv").config();

const { ping } = require("./connection");
const purchasesRoutes = require("./routes/purchases.routes");

app.use(express.json());

app.get("/", (_req, res) => res.send("API de compras funcionando"));
app.get("/ping", async (_req, res) => {
  try {
    const ok = await ping();
    res.json({ db: ok });
  } catch (e) {
    res.status(500).json({ db: false, error: e.message });
  }
});

app.use(purchasesRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API escuchando en puerto ${port}`));
