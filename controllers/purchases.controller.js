const { pool } = require("../connection");

function validatePostBody(body) {
  const errors = [];
  if (typeof body?.user_id !== "number")
    errors.push("user_id es requerido (number).");
  if (typeof body?.status !== "string")
    errors.push("status es requerido (string).");
  if (!Array.isArray(body?.details))
    errors.push("details es requerido (array).");
  if (Array.isArray(body?.details) && body.details.length === 0)
    errors.push("Debe haber al menos 1 producto en la compra.");
  if (Array.isArray(body?.details) && body.details.length > 5)
    errors.push("No se pueden guardar más de 5 productos por compra.");

  let computedTotal = 0;
  if (Array.isArray(body?.details)) {
    for (const [i, d] of body.details.entries()) {
      if (typeof d?.product_id !== "number")
        errors.push(`details[${i}].product_id es requerido (number).`);
      if (typeof d?.quantity !== "number" || d.quantity <= 0)
        errors.push(`details[${i}].quantity debe ser > 0.`);
      if (typeof d?.price !== "number" || d.price < 0)
        errors.push(`details[${i}].price debe ser ≥ 0.`);
      if (typeof d?.quantity === "number" && typeof d?.price === "number") {
        computedTotal += d.quantity * d.price;
      }
    }
  }
  if (computedTotal > 3500)
    errors.push("El total de la compra no puede ser mayor a $3500.");
  return {
    ok: errors.length === 0,
    errors,
    computedTotal: Number(computedTotal.toFixed(2)),
  };
}

function validatePutBody(body) {
  const errors = [];
  let computedTotal = null;

  if (body.details !== undefined) {
    if (!Array.isArray(body.details))
      errors.push("details debe ser un array si se incluye.");
    if (Array.isArray(body.details)) {
      if (body.details.length === 0)
        errors.push("Si envías details, debe tener al menos 1 producto.");
      if (body.details.length > 5)
        errors.push("No se pueden guardar más de 5 productos por compra.");

      let sum = 0;
      for (const [i, d] of body.details.entries()) {
        if (typeof d?.product_id !== "number")
          errors.push(`details[${i}].product_id es requerido (number).`);
        if (typeof d?.quantity !== "number" || d.quantity <= 0)
          errors.push(`details[${i}].quantity debe ser > 0.`);
        if (typeof d?.price !== "number" || d.price < 0)
          errors.push(`details[${i}].price debe ser ≥ 0.`);
        if (typeof d?.quantity === "number" && typeof d?.price === "number")
          sum += d.quantity * d.price;
      }
      computedTotal = Number(sum.toFixed(2));
      if (computedTotal > 3500)
        errors.push("El total de la compra no puede ser mayor a $3500.");
    }
  }
  if (body.user_id !== undefined && typeof body.user_id !== "number")
    errors.push("user_id debe ser number si se incluye.");
  if (body.status !== undefined && typeof body.status !== "string")
    errors.push("status debe ser string si se incluye.");

  return { ok: errors.length === 0, errors, computedTotal };
}

exports.createPurchase = async (req, res) => {
  const { ok, errors, computedTotal } = validatePostBody(req.body);
  if (!ok)
    return res.status(400).json({ message: "Validación fallida", errors });

  const { user_id, status, details } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const productIds = details.map((d) => d.product_id);
    const [rows] = await conn.query(
      `SELECT id, stock FROM products WHERE id IN (${productIds
        .map(() => "?")
        .join(",")}) FOR UPDATE`,
      productIds
    );
    const stockMap = new Map(rows.map((r) => [r.id, r.stock]));
    for (const d of details) {
      const cur = stockMap.get(d.product_id);
      if (cur === undefined)
        throw new Error(`Producto ${d.product_id} no existe.`);
      if (cur < d.quantity)
        throw new Error(
          `Stock insuficiente para producto ${d.product_id}. Disponible: ${cur}, requerido: ${d.quantity}`
        );
    }

    const [ins] = await conn.query(
      `INSERT INTO purchases (user_id, total, status, purchase_date, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())`,
      [user_id, computedTotal, status]
    );
    const purchaseId = ins.insertId;

    for (const d of details) {
      const subtotal = Number((d.quantity * d.price).toFixed(2));
      await conn.query(
        `INSERT INTO purchase_details (purchase_id, product_id, quantity, price, subtotal)
         VALUES (?, ?, ?, ?, ?)`,
        [purchaseId, d.product_id, d.quantity, d.price, subtotal]
      );
      const [upd] = await conn.query(
        `UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?`,
        [d.quantity, d.product_id, d.quantity]
      );
      if (upd.affectedRows === 0)
        throw new Error(
          `No fue posible descontar stock para producto ${d.product_id}.`
        );
    }

    await conn.commit();
    res.status(201).json({ message: "Compra creada", id: purchaseId });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ message: e.message });
  } finally {
    conn.release();
  }
};

exports.updatePurchase = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id))
    return res.status(400).json({ message: "id inválido" });
  const { ok, errors, computedTotal } = validatePutBody(req.body);
  if (!ok)
    return res.status(400).json({ message: "Validación fallida", errors });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[purchase]] = await conn.query(
      `SELECT id, status FROM purchases WHERE id = ? FOR UPDATE`,
      [id]
    );
    if (!purchase) {
      await conn.rollback();
      return res.status(404).json({ message: "Compra no encontrada" });
    }
    if (purchase.status?.toUpperCase() === "COMPLETED") {
      await conn.rollback();
      return res
        .status(409)
        .json({ message: "Una compra COMPLETED no puede modificarse" });
    }

    if (req.body.details !== undefined) {
      const [curr] = await conn.query(
        `SELECT product_id, quantity FROM purchase_details WHERE purchase_id = ? FOR UPDATE`,
        [id]
      );
      for (const cd of curr) {
        await conn.query(`UPDATE products SET stock = stock + ? WHERE id = ?`, [
          cd.quantity,
          cd.product_id,
        ]);
      }
      await conn.query(`DELETE FROM purchase_details WHERE purchase_id = ?`, [
        id,
      ]);

      const details = req.body.details;
      const productIds = details.map((d) => d.product_id);
      const [rows] = await conn.query(
        `SELECT id, stock FROM products WHERE id IN (${productIds
          .map(() => "?")
          .join(",")}) FOR UPDATE`,
        productIds
      );
      const stockMap = new Map(rows.map((r) => [r.id, r.stock]));
      for (const d of details) {
        const cur = stockMap.get(d.product_id);
        if (cur === undefined)
          throw new Error(`Producto ${d.product_id} no existe.`);
        if (cur < d.quantity)
          throw new Error(
            `Stock insuficiente para producto ${d.product_id}. Disponible: ${cur}, requerido: ${d.quantity}`
          );
      }

      for (const d of details) {
        const subtotal = Number((d.quantity * d.price).toFixed(2));
        await conn.query(
          `INSERT INTO purchase_details (purchase_id, product_id, quantity, price, subtotal)
           VALUES (?, ?, ?, ?, ?)`,
          [id, d.product_id, d.quantity, d.price, subtotal]
        );
        const [upd] = await conn.query(
          `UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?`,
          [d.quantity, d.product_id, d.quantity]
        );
        if (upd.affectedRows === 0)
          throw new Error(
            `No fue posible descontar stock para producto ${d.product_id}.`
          );
      }
    }

    const fields = [];
    const values = [];
    if (req.body.user_id !== undefined) {
      fields.push("user_id = ?");
      values.push(req.body.user_id);
    }
    if (req.body.status !== undefined) {
      fields.push("status = ?");
      values.push(req.body.status);
    }
    if (req.body.details !== undefined) {
      fields.push("total = ?");
      values.push(computedTotal);
    }
    fields.push("updated_at = NOW()");

    if (fields.length > 0) {
      const sql = `UPDATE purchases SET ${fields.join(", ")} WHERE id = ?`;
      values.push(id);
      await conn.query(sql, values);
    }

    await conn.commit();
    res.json({ message: "Compra actualizada" });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ message: e.message });
  } finally {
    conn.release();
  }
};

exports.deletePurchase = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id))
    return res.status(400).json({ message: "id inválido" });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[purchase]] = await conn.query(
      `SELECT id, status FROM purchases WHERE id = ? FOR UPDATE`,
      [id]
    );
    if (!purchase) {
      await conn.rollback();
      return res.status(404).json({ message: "Compra no encontrada" });
    }
    if (purchase.status?.toUpperCase() === "COMPLETED") {
      await conn.rollback();
      return res
        .status(409)
        .json({ message: "No se pueden borrar compras en estatus COMPLETED" });
    }

    const [details] = await conn.query(
      `SELECT product_id, quantity FROM purchase_details WHERE purchase_id = ? FOR UPDATE`,
      [id]
    );
    for (const d of details) {
      await conn.query(`UPDATE products SET stock = stock + ? WHERE id = ?`, [
        d.quantity,
        d.product_id,
      ]);
    }
    await conn.query(`DELETE FROM purchase_details WHERE purchase_id = ?`, [
      id,
    ]);
    await conn.query(`DELETE FROM purchases WHERE id = ?`, [id]);

    await conn.commit();
    res.json({ message: "Compra eliminada" });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ message: e.message });
  } finally {
    conn.release();
  }
};

exports.listPurchases = async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `
      SELECT
        p.id AS purchase_id,
        u.name AS user_name,
        p.total, p.status, p.purchase_date,
        pd.id AS detail_id,
        pr.name AS product_name,
        pd.quantity, pd.price, pd.subtotal
      FROM purchases p
      JOIN users u           ON u.id = p.user_id
      LEFT JOIN purchase_details pd ON pd.purchase_id = p.id
      LEFT JOIN products pr         ON pr.id = pd.product_id
      ORDER BY p.id, pd.id
      `
    );
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.purchase_id)) {
        map.set(r.purchase_id, {
          id: r.purchase_id,
          user: r.user_name,
          total: Number(r.total),
          status: r.status,
          purchase_date: r.purchase_date,
          details: [],
        });
      }
      if (r.detail_id) {
        map.get(r.purchase_id).details.push({
          id: r.detail_id,
          product: r.product_name,
          quantity: r.quantity,
          price: Number(r.price),
          subtotal: Number(r.subtotal),
        });
      }
    }
    res.json(Array.from(map.values()));
  } catch (e) {
    res
      .status(500)
      .json({ message: "Error al obtener compras", error: e.message });
  }
};

exports.getPurchaseById = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id))
    return res.status(400).json({ message: "id inválido" });

  try {
    const [rows] = await pool.query(
      `
      SELECT
        p.id AS purchase_id,
        u.name AS user_name,
        p.total, p.status, p.purchase_date,
        pd.id AS detail_id,
        pr.name AS product_name,
        pd.quantity, pd.price, pd.subtotal
      FROM purchases p
      JOIN users u           ON u.id = p.user_id
      LEFT JOIN purchase_details pd ON pd.purchase_id = p.id
      LEFT JOIN products pr         ON pr.id = pd.product_id
      WHERE p.id = ?
      ORDER BY pd.id
      `,
      [id]
    );
    if (rows.length === 0)
      return res.status(404).json({ message: "Compra no encontrada" });

    const base = {
      id: rows[0].purchase_id,
      user: rows[0].user_name,
      total: Number(rows[0].total),
      status: rows[0].status,
      purchase_date: rows[0].purchase_date,
      details: [],
    };
    for (const r of rows) {
      if (r.detail_id) {
        base.details.push({
          id: r.detail_id,
          product: r.product_name,
          quantity: r.quantity,
          price: Number(r.price),
          subtotal: Number(r.subtotal),
        });
      }
    }
    res.json(base);
  } catch (e) {
    res
      .status(500)
      .json({ message: "Error al obtener la compra", error: e.message });
  }
};
