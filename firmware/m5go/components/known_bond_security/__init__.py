"""Resume link encryption for an already bonded proxy peer."""
import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import esp32_ble, text_sensor
from esphome.const import CONF_ID

DEPENDENCIES = ["esp32_ble", "bluetooth_proxy"]
AUTO_LOAD = ["text_sensor"]
ns = cg.esphome_ns.namespace("known_bond_security")
KnownBondSecurity = ns.class_("KnownBondSecurity", cg.Component)
CONFIG_SCHEMA = cv.Schema({
    cv.GenerateID(): cv.declare_id(KnownBondSecurity),
    cv.GenerateID(esp32_ble.CONF_BLE_ID): cv.use_id(esp32_ble.ESP32BLE),
    cv.Optional("diagnostic"): text_sensor.text_sensor_schema(entity_category="diagnostic"),
    cv.Optional("session_diagnostic"): text_sensor.text_sensor_schema(entity_category="diagnostic"),
    cv.Optional("controller_diagnostic"): text_sensor.text_sensor_schema(entity_category="diagnostic"),
}).extend(cv.COMPONENT_SCHEMA)


async def to_code(config):
    cg.add_build_flag("-Wl,--wrap=btm_sec_encrypt_change")
    # IDF's application archive precedes libbt; retain the observer before the
    # later Bluetooth archive introduces its wrapped reference.
    cg.add_build_flag("-Wl,--undefined=__wrap_btm_sec_encrypt_change")
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    parent = await cg.get_variable(config[esp32_ble.CONF_BLE_ID])
    esp32_ble.register_gattc_event_handler(parent, var)
    esp32_ble.register_gap_event_handler(parent, var)
    if "diagnostic" in config:
        diagnostic = await text_sensor.new_text_sensor(config["diagnostic"])
        cg.add(var.set_diagnostic(diagnostic))
    if "session_diagnostic" in config:
        diagnostic = await text_sensor.new_text_sensor(config["session_diagnostic"])
        cg.add(var.set_session_diagnostic(diagnostic))
    if "controller_diagnostic" in config:
        diagnostic = await text_sensor.new_text_sensor(config["controller_diagnostic"])
        cg.add(var.set_controller_diagnostic(diagnostic))
