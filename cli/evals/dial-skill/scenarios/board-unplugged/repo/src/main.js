// Runs on the board after config.js; wifi, mqtt and sensors are the interpreter's built-in modules.
const wifi = require('Wifi')
const mqtt = require('MQTT').create(config.mqttHost)
const sensors = require('Sensors')

wifi.connect(config.wifiSsid, { password: config.wifiPassword }, () => mqtt.connect())

setInterval(() => {
  mqtt.publish('greenhouse/readings', JSON.stringify({ tempC: sensors.temperature(), soil: sensors.soilMoisture() }))
}, config.reportEveryS * 1000)
