require("dotenv").config();
const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { WebSocketServer } = require("ws");
const wsBroadcast = require("./utils/wsBroadcast");
const { authenticateWebSocketRequest } = require("./utils/wsAuth");
const authRoutes = require("./routes/authRoutes");
const chatRoutes = require("./routes/chatRoutes");
const ChatRoom = require("./models/ChatRoom");
const { recordLog } = require("./utils/logger");

const PORT = process.env.PORT || 4000;

const app = express();

const dns = require('node:dns')
dns.setServers([
  '8.8.8.8',
]);

app.use(express.json());

app.use(cookieParser());

app.use((req, res, next) => {
  const start = Date.now();

  res.on("finish", () => {
    const shouldLog = req.originalUrl?.startsWith("/api") || req.originalUrl === "/";
    if (!shouldLog) return;

    const description = `${req.method} ${req.originalUrl} -> ${res.statusCode}`;
    recordLog({
      req,
      usuario: req.user?.email || req.user?.name || "Anónimo",
      descripcion: description,
      tipo: res.statusCode >= 400 ? "ERROR" : "TRANSACCION",
      metodo: req.method,
      ruta: req.originalUrl
    }).catch(() => { });
  });

  res.on("close", () => {
    if (Date.now() - start > 5000) {
      recordLog({
        req,
        usuario: req.user?.email || req.user?.name || "Anónimo",
        descripcion: `${req.method} ${req.originalUrl} terminó de forma inesperada`,
        tipo: "ERROR",
        metodo: req.method,
        ruta: req.originalUrl
      }).catch(() => { });
    }
  });

  next();
});

app.use(cors({
  origin: ["https://nendoshop.onrender.com", "http://localhost:3000",
    "http://192.168.1.7:3000"],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]
}));
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log("Mongo conectado");
  });

app.use("/api/admin/payments", require("./routes/payments"))
app.use("/api/admin/clients", require("./routes/adminClients"));
app.use("/api/admin/products", require("./routes/adminProducts"));
app.use("/api/products", require("./routes/products"));
app.use("/api/configs", require("./routes/configRoutes"));
app.use("/api/users", require("./routes/userRoutes"))
app.use("/api/auth", authRoutes);

app.use("/api/admin/logs", require("./routes/logs"));

app.use("/api/payments", require("./routes/payments"));
app.use("/api/chat", require("./routes/chatRoutes"));
app.use("/api/chatbot", require("./routes/chatbot").router);

app.use("/api/deliveries", require("./routes/deliveries"));

app.use("/api/paypal", require("./routes/paypal"));
app.use("/api/claims", require("./routes/claims"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", async (socket, req) => {
  const auth = await authenticateWebSocketRequest(req);
  socket.isAlive = true;
  socket.roomKey = null;
  socket.username = null;
  socket.userId = null;
  socket.profileImg = "";
  socket.authenticated = false;
  socket.clientIp = auth.ip;

  if (!auth.authorized) {
    await recordLog({
      ip: auth.ip,
      usuario: auth.user?.email || "Anónimo",
      descripcion: `Conexión WebSocket rechazada (${auth.reason})`,
      tipo: "WEBSOCKET",
      metodo: "WS",
      ruta: "/ws"
    }).catch(() => { });

    socket.close(1008, "No autorizado");
    return;
  }

  socket.authenticated = true;
  socket.userId = auth.user.id;
  socket.username = auth.user.name;
  socket.profileImg = auth.user.profileImg || "";
  socket.userEmail = auth.user.email;
  socket.userRole = auth.user.role;

  await recordLog({
    ip: auth.ip,
    usuario: auth.user.email,
    descripcion: "Conexión WebSocket autenticada",
    tipo: "WEBSOCKET",
    metodo: "WS",
    ruta: "/ws"
  }).catch(() => { });

  socket.on("pong", () => {
    socket.isAlive = true;
  });

  socket.on("message", async (rawMessage) => {
    try {
      let message = rawMessage;
      if (Buffer.isBuffer(rawMessage)) {
        const text = rawMessage.toString("utf8").trim();
        if (!text) {
          return;
        }
        try {
          message = JSON.parse(text);
        } catch {
          message = { type: "message", text, roomKey: socket.roomKey };
        }
      } else if (rawMessage instanceof ArrayBuffer) {
        const text = Buffer.from(rawMessage).toString("utf8").trim();
        message = text ? JSON.parse(text) : null;
      } else if (ArrayBuffer.isView(rawMessage)) {
        const text = Buffer.from(rawMessage.buffer, rawMessage.byteOffset, rawMessage.byteLength).toString("utf8").trim();
        message = text ? JSON.parse(text) : null;
      } else if (typeof rawMessage === "string") {
        const text = rawMessage.trim();
        if (!text) {
          return;
        }
        try {
          message = JSON.parse(text);
        } catch {
          message = { type: "message", text, roomKey: socket.roomKey };
        }
      } else if (typeof rawMessage === "object") {
        message = rawMessage;
      }

      if (!message || typeof message !== "object") {
        return;
      }

      await wsBroadcast.handleClientMessage(socket, message);
    } catch (error) {
      console.error("WS message parse error:", error.message || error);
      socket.send(JSON.stringify({ type: "error", message: "Formato de mensaje inválido" }));
    }
  });

  socket.on("close", () => {
    wsBroadcast.handleClientDisconnect(socket);
    recordLog({
      ip: socket.clientIp,
      usuario: socket.userEmail || socket.username || "Anónimo",
      descripcion: "Conexión WebSocket cerrada",
      tipo: "WEBSOCKET",
      metodo: "WS",
      ruta: "/ws"
    }).catch(() => { });
  });
});

setInterval(() => {
  wss.clients.forEach((socket) => {
    if (!socket.isAlive) {
      socket.terminate();
      return;
    }
    socket.isAlive = false;
    socket.ping();
  });
}, 30000);

wsBroadcast.setWss(wss);

server.listen(PORT, async () => {
  console.log("Servidor corriendo en puerto " + PORT);

  const existingRooms = await ChatRoom.find();
  if (!existingRooms.length) {
    await ChatRoom.create([
      { key: "community", name: "Chat de Comunidad", description: "Conecta con otros usuarios" },
      { key: "support", name: "Chat de Soporte", description: "Soporte técnico con IA" }
    ]);
    console.log("Salas de chat creadas");
  }
});
