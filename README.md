Este documento describe las operaciones CRUD (Crear, Leer, Actualizar y Eliminar) para la
tabla 'purchases'. Cada compra puede contener uno o más registros en la tabla
'purchase_details'.
Puntos a tomar en cuenta
• Que haya stock disponible en cada producto
• Descontar el stock del producto una vez que se haya guardado
• La fecha de creación debe tomarse al momento del insert
• No se pueden guardar mas de 5 productos por compra
• El total de la compra, no puede pasar la cantidad de $3500
• Todos los campos que se mencionan en el JSON seran obligatorios
• Minimo debe de haber un producto en la compra
