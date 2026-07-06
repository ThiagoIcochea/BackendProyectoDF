const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API_URL = process.env.PAYPAL_API_URL || "https://api-m.sandbox.paypal.com";

/**
 * ¿CÓMO funciona esta función?
 * Realiza una petición de autenticación OAuth2 a la API de PayPal usando Basic Auth.
 * Codifica las credenciales CLIENT_ID y CLIENT_SECRET en Base64 y las envía en la cabecera 'Authorization'.
 * 
 * ¿POR QUÉ esta estructura?
 * PayPal requiere un token de acceso de corta duración (Access Token) para autorizar todas las peticiones
 * a sus endpoints de órdenes. Generarlo dinámicamente asegura que las solicitudes no fallen por expiración.
 */
async function getPayPalAccessToken() {
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
        throw new Error("Faltan las credenciales PAYPAL_CLIENT_ID o PAYPAL_CLIENT_SECRET en las variables de entorno.");
    }

    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
    
    try {
        const response = await fetch(`${PAYPAL_API_URL}/v1/oauth2/token`, {
            method: "POST",
            headers: {
                "Authorization": `Basic ${auth}`,
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: "grant_type=client_credentials"
        });

        if (!response.ok) {
            const errorDetails = await response.text();
            throw new Error(`Error de PayPal OAuth: ${response.statusText} - ${errorDetails}`);
        }

        const data = await response.json();
        return data.access_token;
    } catch (error) {
        console.error("Error al obtener PayPal Access Token:", error);
        throw error;
    }
}

/**
 * ¿CÓMO funciona esta función?
 * Llama al endpoint v2/checkout/orders para registrar una intención de pago (CAPTURE) con el monto indicado.
 * 
 * ¿POR QUÉ esta estructura?
 * Antes de que el usuario pueda pagar, debemos generar una orden en los servidores de PayPal. Esto nos devuelve
 * un ID de orden y una URL de redirección (approve link) para que el cliente autorice la transacción en el frontend.
 */
async function createPayPalOrder(amount) {
    try {
        const accessToken = await getPayPalAccessToken();

        const response = await fetch(`${PAYPAL_API_URL}/v2/checkout/orders`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                intent: "CAPTURE",
                purchase_units: [
                    {
                        amount: {
                            currency_code: "USD",
                            value: parseFloat(amount).toFixed(2)
                        }
                    }
                ]
            })
        });

        if (!response.ok) {
            const errorDetails = await response.text();
            throw new Error(`Error al crear orden en PayPal: ${response.statusText} - ${errorDetails}`);
        }

        return await response.json();
    } catch (error) {
        console.error("Error en createPayPalOrder:", error);
        throw error;
    }
}

/**
 * ¿CÓMO funciona esta función?
 * Envía una petición POST al endpoint de captura de una orden específica de PayPal.
 * 
 * ¿POR QUÉ esta estructura?
 * Cuando el usuario aprueba el pago en el frontend, el dinero queda retenido temporalmente. Esta función
 * captura oficialmente los fondos para que pasen a la cuenta del comercio. Si la respuesta es 'COMPLETED',
 * el pago se considera exitoso y cerrado.
 */
async function capturePayPalOrder(orderId) {
    try {
        const accessToken = await getPayPalAccessToken();

        const response = await fetch(`${PAYPAL_API_URL}/v2/checkout/orders/${orderId}/capture`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            }
        });

        if (!response.ok) {
            const errorDetails = await response.text();
            throw new Error(`Error al capturar orden en PayPal: ${response.statusText} - ${errorDetails}`);
        }

        return await response.json();
    } catch (error) {
        console.error("Error en capturePayPalOrder:", error);
        throw error;
    }
}

module.exports = {
    getPayPalAccessToken,
    createPayPalOrder,
    capturePayPalOrder
};
