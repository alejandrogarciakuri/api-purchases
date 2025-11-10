const { Router } = require("express");
const ctrl = require("../controllers/purchases.controller");
const router = Router();

router.post("/api/purchases", ctrl.createPurchase);
router.get("/api/purchases", ctrl.listPurchases);
router.get("/api/purchases/:id", ctrl.getPurchaseById);
router.put("/api/purchases/:id", ctrl.updatePurchase);
router.delete("/api/purchases/:id", ctrl.deletePurchase);

module.exports = router;
