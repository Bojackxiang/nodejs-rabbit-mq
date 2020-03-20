var express = require("express");
var app = express();
var bodyParser = require("body-parser");
app.use(bodyParser.json());
app.use(
    bodyParser.urlencoded({
        extended: true
    })
);

var redis = require("redis");
var client = redis.createClient("8383", "127.0.0.1");

var amqp = require("amqp");
var amqpConn = amqp.createConnection({
    url: "amqp:guest:guest@127.0.0.1:5672"
});

client.on("error", function(error) {
    console.log(error);
});

var mysql = require("mysql");
var mysqlConn = mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "root",
    database: "test"
});
var orderQueue;
var amqpConnReady = false;


amqpConn.on("ready", function() {
    amqpConnReady = true;
    amqpConn.queue("orderQueue", { durable: true, autoDelete: false }, function(
        queue
    ) {
        orderQueue = queue;
        mysqlConn.connect();
        queue.subscribe(function(message, header, deliveryInfo) {
            if (message.data) {
                var messageText = message.data.toString();
                
                var data = JSON.parse(messageText);
                
                var sql =
                    "SELECT * FROM `address` WHERE `id` = " +
                    parseInt(data.address) +
                    " AND `user_id` = " +
                    data.user_id;
                mysqlConn.query(sql, function(err, result) {
                    if (err) {
                        console.log("[SELECT address  ERROR] - ", err.message);
                        return;
                    }
                    if (result) {
                        data.address = JSON.stringify(result[0]);
                        
                        var addSql =
                            "INSERT INTO `order` (`user_id`,`orderno`,`goods_id`,`address`,`status`,`amount`,`ip`,`express`,`invoice`,`message`,`create_time`,`update_time`) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)";
                        var addSqlParams = [
                            data.user_id,
                            data.orderno,
                            data.goods_id,
                            data.address,
                            data.status,
                            data.amount,
                            data.ip,
                            data.express,
                            data.invoice,
                            data.message,
                            data.create_time,
                            data.update_time
                        ];
                        mysqlConn.query(addSql, addSqlParams, function(
                            err,
                            result
                        ) {
                            if (err) {
                                console.log(
                                    "[INSERT Order ERROR] - ",
                                    err.message
                                );
                                return;
                            } else {

                                var modSql =
                                    "UPDATE `goods` SET `stock` = `stock`-1,`sold` = `sold`+1 WHERE `id` = ?";
                                var modSqlParams = [data.goods_id];
                                mysqlConn.query(modSql, modSqlParams, function(
                                    err,
                                    result
                                ) {
                                    if (err) {
                                        console.log(
                                            "[UPDATE Goods stock ERROR] - ",
                                            err.message
                                        );
                                        return;
                                    }
                                });
                                console.log("INSERT Order Ok");
                            }
                        });
                    }
                });
            }
        });
    });
});

function getUserId(res, token, callback) {
    if (!token) {
        jsonResponse(res, 500, "身份验证失败");
    } else {
        return client.get(token, function(err, tokenInfo) {
            if (err) {
                console.log(err);
            } else {
                if (!tokenInfo) {
                    jsonResponse(res, 500, "身份验证失败，请重新登录");
                } else {
                    var user_id = JSON.parse(tokenInfo).id;
                    callback(user_id);
                }
            }
        });
    }
}

function jsonResponse(res, code, message, data) {
    return res.json({ code: code, message: message, data: data });
}

function getOrderNo() {
    var date = new Date();
    var month = date.getMonth() + 1;
    var strDate = date.getDate();
    if (month >= 1 && month <= 9) {
        month = "0" + month;
    }
    if (strDate >= 0 && strDate <= 9) {
        strDate = "0" + strDate;
    }
    var currentdate =
        date.getFullYear() +
        month +
        strDate +
        date.getHours() +
        date.getMinutes() +
        date.getSeconds();
    return currentdate + Math.floor(Math.random() * 10000) + "";
}

function publishOrderMessage(res, data) {
    if (amqpConnReady) {
        amqpConn.publish("orderQueue", JSON.stringify(data));
    }
}

function getClientIP(req) {
    return (
        req.headers["x-forwarded-for"] || 
        req.connection.remoteAddress || 
        req.socket.remoteAddress || 
        req.connection.socket.remoteAddress
    );
}


app.post("/order", function(req, res) {
    var goods_id = req.body.id;
    var address_id = req.body.address_id;
    var express = req.body.express;
    var invoice = req.body.invoice;
    var message = req.body.message;
    var token = req.get("HTTP_TOKEN");
    if (!address_id) {
        jsonResponse(res, 500, "请选择一个收货地址");
    } else {
        getUserId(res, token, function(user_id) {

            var goods_key = "goods:" + goods_id;
            client.get(goods_key, function(err, goods) {
                if (err) {
                    console.log(err);
                } else {
                    goods = JSON.parse(goods);
                    if (goods == null) {
                        jsonResponse(res, 404, "404");
                    } else {
                        var time = Date.parse(new Date()) + "";
                        time = parseInt(time.substr(0, 10));
                        if (goods.end_time < time) {
                            jsonResponse(res, 500, "秒杀已结束");
                        } else if (goods.start_time > time) {
                            jsonResponse(res, 500, "秒杀还未开始");
                        } else {
                            
                            var goods_stock_key = "goods_stock:" + goods_id;
                            client.llen(goods_stock_key, function(err, stock) {
                                if (err) {
                                    console.log(err);
                                } else {
                                    if (stock <= 0) {
                                        jsonResponse(res, 500, "库存不足");
                                    } else {
                                        var orderNo = getOrderNo();
                                        var data = {
                                            user_id: user_id,
                                            orderno: orderNo,
                                            goods_id: goods_id,
                                            address: address_id,
                                            status: 1,
                                            amount: goods.kill_price,
                                            ip: getClientIP(req),
                                            express: express,
                                            invoice: invoice,
                                            message: message,
                                            create_time: time,
                                            update_time: time
                                        };
                                        
                                        client.lpop(goods_stock_key, function(
                                            err,
                                            ret
                                        ) {
                                            if (err) {
                                                console.log(err);
                                            } else {

                                                publishOrderMessage(res, data);
                                                var response_data = {
                                                    amount: data.amount,
                                                    orderno: data.orderno
                                                };
                                                jsonResponse(
                                                    res,
                                                    200,
                                                    "ok",
                                                    response_data
                                                );
                                            }
                                        });
                                    }
                                }
                            });
                        }
                    }
                }
            });
        });
    }
});

var server = app.listen(3000, function() {
    var host = server.address().address;
    var port = server.address().port;
});
