# Backend del Proyecto DF - Sistema de Comercio Electrónico

Este es el backend oficial del proyecto desarrollado en Node.js, Express y MongoDB (usando Mongoose como ORM).

---

## Módulos del Sistema

### Nuevo: Pasarela de Pago PayPal Sandbox - API REST v2
Este módulo integra de forma paralela la pasarela de pago PayPal Sandbox a través de llamadas directas a su API REST v2, utilizando el cliente nativo de Node.js v22 para garantizar mayor ligereza y evitar dependencias obsoletas.

#### Propósito de la Funcionalidad
- **Pagos en Línea Seguros:** Permite realizar transacciones con tarjetas de débito/crédito y balances de cuentas PayPal en un entorno de desarrollo seguro (Sandbox).
- **Consistencia de Datos:** Tras una captura exitosa en la pasarela, se reutiliza el esquema común `Payment` para guardar la transacción local con estado `"Pagado"`, permitiendo que el flujo de entrega posterior continúe de manera estándar.
- **Auditoría e Integridad:** Cada evento relevante del proceso genera registros en la colección de Logs y alertas de WebSocket para productos en descuento.

#### Contrato de Endpoints (Rutas)
Las rutas del módulo están registradas bajo `/api/paypal` en `server.js`:
1. **Crear Orden:** `POST /api/paypal/create-order`
   - Requiere: Token de autenticación.
   - Entrada: JSON con el campo `total` (monto decimal).
   - Retorna: ID de la orden de PayPal y enlaces de redirección para aprobación del cliente.
2. **Capturar Pago:** `POST /api/paypal/capture-order`
   - Requiere: Token de autenticación.
   - Entrada: JSON con `orderId` de PayPal y el objeto `paymentData` (estructura compatible con el modelo `Payment`).
   - Retorna: Registro del pago guardado localmente en MongoDB con estado `"Pagado"`.

### Integración: Módulo de Entregas Omnicanal (Deliveries) - Logística Flexible
Este módulo maneja de forma independiente el ciclo de vida logístico y rastreo de despachos asociados a las compras (`Payments`), adaptándose dinámicamente al tipo de entrega seleccionado por el cliente ("Envío a Domicilio" vs "Retiro en Tienda").

#### Propósito de la Funcionalidad
- **Soporte Omnicanal:** Soporta esquemas de envío (`shipping`) y retiro en tienda (`pickup`), optimizando la captura de datos en base al canal seleccionado.
- **Validación Estricta:** Impide la entrada de datos basura (direcciones/agencias para retiros en tienda) y exige datos completos si es un envío a domicilio.
- **Operaciones de Registro Rápido (Upsert):** El endpoint de creación actúa como un upsert lógico basado en el `paymentId` para evitar duplicación de despachos y mantener consistencia financiera.
- **Lecturas Enriquecidas (Populate):** Los endpoints de consulta pueblan la referencia del pago (`paymentId`), permitiendo que el frontend reciba directamente los detalles del cliente y transacción en una sola petición.

#### Esquema del Modelo (`Delivery`)
- `paymentId`: `ObjectId` (Mapea obligatoriamente al modelo `Payment`).
- `deliveryType`: String (`shipping` | `pickup`). Requerido.
- `status`: String (`pending` | `ready_for_pickup` | `shipped` | `delivered`). Por defecto es `pending`.
- `destinationAddress`: String (Requerido solo si `deliveryType === 'shipping'`).
- `reference`: String (Requerido solo si `deliveryType === 'shipping'`).
- `agency`: String (Requerido solo si `deliveryType === 'shipping'`).
- `trackingCode`: String (Código único para rastreo externo).
- `estimatedDate`: Date (Fecha estimada de despacho/llegada).

#### Contrato de Endpoints (Rutas)
Las rutas del módulo están registradas bajo `/api/deliveries` en `server.js`:

1. **Registrar/Actualizar un despacho:** `POST /api/deliveries`
   - Requiere: Token de autenticación (`verifyToken`).
   - Entrada: JSON con `paymentId`, y opcionalmente `destinationAddress`, `reference` y `agency` si corresponde.
   - Lógica: Compara el `deliveryType` del pago; si es `pickup` y se envían datos de dirección/agencia, rechaza con HTTP 400. Si es `shipping` y faltan campos, rechaza con HTTP 400. Si pasa las validaciones, hace un upsert de la entrega.
2. **Listado global:** `GET /api/deliveries`
   - Requiere: Administrador (`verifyToken`, `isAdmin`).
   - Retorna: Array de entregas ordenadas de forma descendente, con información del pago poblada (`.populate("paymentId")`).
3. **Consulta por compra:** `GET /api/deliveries/:paymentId`
   - Requiere: Token de autenticación.
   - Retorna: Objeto de entrega correspondiente con información del pago poblada.
4. **Actualización de entrega por ID:** `PUT /api/deliveries/:id`
   - Requiere: Administrador (`verifyToken`, `isAdmin`).
   - Entrada: Parámetros a actualizar, respetando las validaciones condicionales del `deliveryType` de la entrega.
5. **Actualización rápida de estado:** `PATCH /api/deliveries/:id/status`
   - Requiere: Administrador (`verifyToken`, `isAdmin`).
   - Entrada: JSON `{ "status": "ready_for_pickup" | "shipped" | "delivered" }`.
   - Retorna: Entrega modificada tras validar el nuevo estado logístico.

---

## Cómo Ejecutar el Entorno Local

### Requisitos Previos
- Node.js LTS (Versión 18+ recomendado, testeado en v22.17.0)
- MongoDB activo (Local o URI de Mongo Atlas en variables de entorno)

### Comandos de Instalación y Ejecución
1. Instalar dependencias del proyecto:
   ```bash
   npm install
   ```
2. Configurar variables de entorno (`.env`):
   Crea un archivo `.env` en la raíz (basándote en las llaves del proyecto) con los siguientes campos:
   ```env
   PORT=4000
   MONGO_URI=mongodb://localhost:27017/tu_bd
   JWT_SECRET=tu_secreto_super_seguro

   # Configuración de PayPal Sandbox (Credenciales obtenidas en developer.paypal.com)
   PAYPAL_CLIENT_ID=tu_client_id_sandbox
   PAYPAL_CLIENT_SECRET=tu_client_secret_sandbox
   PAYPAL_API_URL=https://api-m.sandbox.paypal.com
   ```
3. Levantar el servidor de desarrollo:
   ```bash
   npm run dev
   ```
   *(O alternativamente: `node server.js` / `nodemon server.js` según lo definido en `package.json`)*

---

## Buenas Prácticas y Escalabilidad Futura

Para asegurar la robustez del sistema a medida que el Módulo de Entregas y la Pasarela de PayPal crezcan, se proponen las siguientes prácticas:

### Módulo de Entregas
1. **Webhooks de Agencias de Envío:** Integrar un sistema de recepción de webhooks de transportistas (como Olva o Shalom) para actualizar automáticamente el estado (`deliveryStatus`) y código de tracking sin intervención humana directa.
2. **Historial de Cambios de Estado:** Crear un esquema de auditoría/logs secundario (`DeliveryLogs`) para almacenar la fecha y el usuario (o proceso automático) que realizó cada transición de estado de entrega (ej: de `pending` a `in_transit`).
3. **Notificaciones Push o Emails en Tiempo Real:** Disparar alertas (usando WebSocket, Courier o servicios SMTP) cada vez que el estado de entrega cambie a `in_transit` o `delivered` para optimizar la experiencia de usuario.

### Pasarela de Pagos (PayPal)
1. **Webhooks de PayPal (Conciliación Asíncrona):** En producción, el flujo del frontend puede interrumpirse (ej. si el usuario cierra el navegador tras pagar pero antes de que se complete `capture-order`). Implementar un endpoint de Webhooks para escuchar eventos como `PAYMENT.CAPTURE.COMPLETED` asegura que el pago se registre en la base de datos de manera asíncrona y segura.
2. **Encriptación de Credenciales:** En producciones multi-inquilino o corporativas, evitar guardar secretos planos en el `.env`. Utilizar servicios de bóveda (como AWS Secrets Manager o HashiCorp Vault).
3. **Tolerancia a Fallos y Reintentos:** Implementar políticas de reintentos exponenciales en los llamados HTTP a la API de PayPal para mitigar intermitencias de red temporales.
