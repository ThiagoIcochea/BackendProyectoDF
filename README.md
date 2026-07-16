# Backend DF – API and Services

## English Version

### Description
Backend DF is the Node.js + Express server that powers the NendoShop platform. It exposes REST APIs for authentication, products, payments, deliveries, claims, admin operations, support chat, and WebSocket-based real-time messaging.

### Key Features
- User authentication, registration, profile management, and two-factor verification
- Product catalog and inventory-related operations
- Payment creation and PayPal capture flow
- Delivery and order status lifecycle management
- Claims and refund/review workflow
- Support chat and chatbot response handling
- WebSocket real-time communication for community/support rooms
- Logging and monitoring utilities for transactions and errors

### Technology Stack
- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** MongoDB + Mongoose
- **Real-time:** WebSocket via ws
- **Authentication:** JWT + cookies
- **Email/Messaging:** Resend and webhook-based notification helpers
- **Testing:** Node.js test runner

### Project Architecture
- **server.js**: Main Express server setup, CORS, middleware, route registration, and WebSocket server initialization.
- **routes/**: API route modules such as authRoutes, products, payments, paypal, chatRoutes, chatbot, claims, deliveries, userRoutes, admin routes, and config routes.
- **models/**: Mongoose schemas for User, Product, Payment, Delivery, Claim, ChatRoom, ChatMessage, Config, Log, and related entities.
- **middlewares/**: Request verification middleware such as token validation and admin checks.
- **utils/**: Business logic helpers for MFA, support bot, email notifications, delivery state transitions, logger, validation, and WebSocket broadcast management.
- **tests/**: Automated regression and flow tests for claims, deliveries, email notifications, support bot behavior, and order flow.

### Main API Endpoints
#### Authentication
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/verify-2fa`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`

#### Products
- `GET /api/products`
- `GET /api/products/:id`
- `GET /api/products/search`
- `POST /api/products` (admin)
- `PUT /api/products/:id` (admin)
- `DELETE /api/products/:id` (admin)

#### Payments and PayPal
- `POST /api/payments`
- `GET /api/payments`
- `POST /api/paypal/create-order`
- `POST /api/paypal/capture-order`

#### Deliveries and Orders
- `POST /api/deliveries`
- `GET /api/deliveries`
- `GET /api/deliveries/:paymentId`
- `PUT /api/deliveries/:id`
- `PATCH /api/deliveries/:id/status`
- `PUT /api/deliveries/my-orders/:id/return`

#### Claims
- `GET /api/claims`
- `POST /api/claims`
- `PATCH /api/claims/:id/resolve`

#### Chat and Bot
- `GET /api/chat/rooms/:roomKey/messages`
- `POST /api/chatbot/message`
- `GET /api/chatbot/health`
- **WebSocket:** `/ws` for join/message/typing/report events

#### Admin
- `GET /api/admin/clients`
- `GET /api/admin/products`
- `GET /api/admin/payments`
- `GET /api/admin/logs`

### Run Commands
From the backend project root:

```bash
npm install
npm run dev
```

Alternative production-style start:

```bash
npm start
```

Run the test suite:

```bash
npm test
```

### Environment Variables
Create a `.env` file in the backend root with the following variables:

```env
PORT=4000
MONGO_URI=mongodb://localhost:27017/tu_bd
JWT_SECRET=tu_secreto_super_seguro
RESEND_API_KEY=your_resend_key
RESEND_FROM_EMAIL=onboarding@resend.dev
FRONTEND_URL=http://localhost:3000
NODE_ENV=development
```

### Members
- Icochea Rodriguez, Thiago Paolo (U22330428)
- Chabria Loayza, Percy Alonzo (U20217294)
- Rojas Olano, Aaron Toribio (U22210544)
- Carbajal Añanca, Melany Daniela (U22222750)
- Guevara Morales, Antonio Nicolás (U22217586)
- Gómez Linares, Laura Angélica (U22217117)

---

## Versión en Español

### Descripción
Backend DF es el servidor Node.js + Express que da soporte a la plataforma NendoShop. Expone APIs REST para autenticación, productos, pagos, entregas, reclamos, operaciones administrativas, chat de soporte y mensajería en tiempo real mediante WebSocket.

### Funcionalidades Principales
- Autenticación de usuarios, registro, gestión de perfil y verificación en dos pasos
- Operaciones de catálogo y gestión de inventario
- Creación de pagos y flujo de captura con PayPal
- Gestión del ciclo de vida de entregas y estados de pedidos
- Flujo de reclamos, devoluciones y revisión de casos
- Chat de soporte y manejo de respuestas del chatbot
- Comunicación en tiempo real para salas comunitarias y de soporte
- Utilidades de logs y monitoreo de transacciones y errores

### Tecnologías
- **Runtime:** Node.js
- **Framework:** Express.js
- **Base de datos:** MongoDB + Mongoose
- **Tiempo real:** WebSocket con ws
- **Autenticación:** JWT + cookies
- **Email/Mensajería:** Resend y helpers de notificaciones
- **Pruebas:** Node.js test runner

### Arquitectura del Proyecto
- **server.js**: Configuración principal del servidor Express, CORS, middleware, registro de rutas y inicialización del WebSocket Server.
- **routes/**: Módulos de rutas para auth, productos, pagos, paypal, chat, chatbot, claims, deliveries, usuarios y administración.
- **models/**: Esquemas Mongoose para User, Product, Payment, Delivery, Claim, ChatRoom, ChatMessage, Config, Log y entidades relacionadas.
- **middlewares/**: Middleware para verificación de tokens y permisos de administrador.
- **utils/**: Lógica de negocio para MFA, soporte con IA, correos, transiciones de estado, logger, validación y broadcast por WebSocket.
- **tests/**: Pruebas automatizadas para claims, deliveries, email notifications, support bot y order flow.

### Endpoints Principales de la API
#### Autenticación
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/verify-2fa`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`

#### Productos
- `GET /api/products`
- `GET /api/products/:id`
- `GET /api/products/search`
- `POST /api/products` (admin)
- `PUT /api/products/:id` (admin)
- `DELETE /api/products/:id` (admin)

#### Pagos y PayPal
- `POST /api/payments`
- `GET /api/payments`
- `POST /api/paypal/create-order`
- `POST /api/paypal/capture-order`

#### Entregas y Pedidos
- `POST /api/deliveries`
- `GET /api/deliveries`
- `GET /api/deliveries/:paymentId`
- `PUT /api/deliveries/:id`
- `PATCH /api/deliveries/:id/status`
- `PUT /api/deliveries/my-orders/:id/return`

#### Reclamos
- `GET /api/claims`
- `POST /api/claims`
- `PATCH /api/claims/:id/resolve`

#### Chat y Bot
- `GET /api/chat/rooms/:roomKey/messages`
- `POST /api/chatbot/message`
- `GET /api/chatbot/health`
- **WebSocket:** `/ws` para join, mensajes, typing y reportes

#### Admin
- `GET /api/admin/clients`
- `GET /api/admin/products`
- `GET /api/admin/payments`
- `GET /api/admin/logs`

### Comandos de Ejecución
Desde la raíz del backend:

```bash
npm install
npm run dev
```

Inicio alternativo en modo producción:

```bash
npm start
```

Ejecutar la suite de pruebas:

```bash
npm test
```

### Variables de Entorno
Crea un archivo `.env` en la raíz del backend con estas variables:

```env
PORT=4000
MONGO_URI=mongodb://localhost:27017/tu_bd
JWT_SECRET=tu_secreto_super_seguro
RESEND_API_KEY=your_resend_key
RESEND_FROM_EMAIL=onboarding@resend.dev
FRONTEND_URL=http://localhost:3000
NODE_ENV=development
```

### Integrantes
- Icochea Rodriguez, Thiago Paolo (U22330428)
- Chabria Loayza, Percy Alonzo (U20217294)
- Rojas Olano, Aaron Toribio (U22210544)
- Carbajal Añanca, Melany Daniela (U22222750)
- Guevara Morales, Antonio Nicolás (U22217586)
- Gómez Linares, Laura Angélica (U22217117)
