"""Resume link encryption for an already bonded proxy peer."""
import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import esp32_ble
from esphome.const import CONF_ID

DEPENDENCIES = ["esp32_ble", "bluetooth_proxy"]
ns = cg.esphome_ns.namespace("known_bond_security")
KnownBondSecurity = ns.class_("KnownBondSecurity", cg.Component)
CONFIG_SCHEMA = cv.Schema({
    cv.GenerateID(): cv.declare_id(KnownBondSecurity),
    cv.GenerateID(esp32_ble.CONF_BLE_ID): cv.use_id(esp32_ble.ESP32BLE),
}).extend(cv.COMPONENT_SCHEMA)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    parent = await cg.get_variable(config[esp32_ble.CONF_BLE_ID])
    esp32_ble.register_gattc_event_handler(parent, var)
