const jwt = require("jsonwebtoken");
const User = require("../models/User");

const verifyToken = async (req, res, next) => {

    try {

        const token = req.cookies.token;
        

        if (!token) {

            return res.status(401).json({
                message: "No autenticado"
            });

        }

        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET
        );
        console.log(decoded);

        const user = await User.findById(decoded.id);
        console.log(req.user);

        if (!user) {
            res.clearCookie("token");
            return res.status(401).json({ message: "No autenticado" });
        }

        if (user.chatBlockedUntil && new Date(user.chatBlockedUntil) > new Date()) {
            res.clearCookie("token");
            return res.status(403).json({ message: "Tu cuenta está bloqueada por reportes acumulados." });
        }

        req.user = {
            ...decoded,
            email: user.email,
            role: user.role
        };

        next();

    } catch (error) {

        return res.status(401).json({
            message: "Token inválido"
        });

    }

};

module.exports = verifyToken;
