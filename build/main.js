"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __decorateClass = (decorators, target, key, kind) => {
  var result = kind > 1 ? void 0 : kind ? __getOwnPropDesc(target, key) : target;
  for (var i = decorators.length - 1, decorator; i >= 0; i--)
    if (decorator = decorators[i])
      result = (kind ? decorator(target, key, result) : decorator(result)) || result;
  if (kind && result)
    __defProp(target, key, result);
  return result;
};
var main_exports = {};
module.exports = __toCommonJS(main_exports);
var import_register = require("source-map-support/register");
var import_promises = require("fs/promises");
var crypto = __toESM(require("crypto"));
var import_adapter_core = require("@iobroker/adapter-core");
var import_autobind_decorator = require("autobind-decorator");
var import_sensor = require("./sensor");
var import_remote_server = require("./remote-server");
var import_utils = require("./lib/utils");
var import_i18n = require("./lib/i18n");
class Ds18b20Adapter extends import_adapter_core.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: "ds18b20"
    });
    this.sensors = {};
    this.remoteSensorServer = null;
    this.doingMigration = false;
    this.on("ready", this.onReady);
    this.on("stateChange", this.onStateChange);
    this.on("message", this.onMessage);
    this.on("unload", this.onUnload);
  }
  async onReady() {
    this.setState("info.connection", false, true);
    const systemConfig = await this.getForeignObjectAsync("system.config");
    import_i18n.i18n.language = (systemConfig == null ? void 0 : systemConfig.common.language) || "en";
    if (!this.config.w1DevicesPath) {
      this.config.w1DevicesPath = "/sys/bus/w1/devices";
    }
    if (Object.keys(this.config).includes("_values")) {
      this.log.info("Migrate config from old version ...");
      this.doingMigration = true;
      const instanceObj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
      if (!instanceObj) {
        this.log.error("Could not read instance object!");
        this.terminate("Config migration required", import_adapter_core.EXIT_CODES.INVALID_ADAPTER_CONFIG);
        return;
      }
      const oldNative = instanceObj.native;
      if (oldNative.remoteEnabled) {
        this.log.warn(`Please make sure to re-install you remote clients, or they won't be able to connect!`);
      }
      const newNative = {
        defaultInterval: oldNative.defaultInterval,
        remoteEnabled: oldNative.remoteEnabled,
        remoteKey: oldNative.remoteKey,
        remotePort: oldNative.remotePort,
        w1DevicesPath: oldNative.w1DevicesPath,
        sensors: []
      };
      oldNative._values.sort((a, b) => {
        if (typeof a.sortOrder === "number" && typeof b.sortOrder === "number") {
          return a.sortOrder - b.sortOrder;
        }
        return 0;
      });
      for (const oldSensor of oldNative._values) {
        const { obj, sortOrder, ...sensor } = oldSensor;
        newNative.sensors.push(sensor);
      }
      await Promise.all([
        this.delObjectAsync("actions"),
        this.delObjectAsync("actions.readNow"),
        this.delObjectAsync("info"),
        this.delObjectAsync("info.connection"),
        this.delObjectAsync("sensors")
      ]);
      instanceObj.native = newNative;
      this.log.info("Rewriting adapter config");
      this.setForeignObjectAsync(`system.adapter.${this.namespace}`, instanceObj);
      this.terminate("Restart adapter to apply config changes", import_adapter_core.EXIT_CODES.START_IMMEDIATELY_AFTER_STOP);
      return;
    }
    if (this.config.remoteEnabled) {
      if (!this.config.remotePort || this.config.remotePort <= 0) {
        this.log.warn("Config: Invalid port for the remote sensor server! Using default port 1820.");
        this.config.remotePort = 1820;
      }
      if (typeof this.config.remoteKey !== "string" || this.config.remoteKey.length !== 64) {
        this.config.remoteKey = crypto.randomBytes(32).toString("hex");
        this.log.error(`Config: Invalid key for the remote sensor server! Using random key "${this.config.remoteKey}".`);
      }
      await this.extendObjectAsync("info.remotesConnected", {
        type: "state",
        common: {
          name: import_i18n.i18n.getStringOrTranslated("Connected remote systems"),
          type: "string",
          role: "state",
          read: true,
          write: false,
          def: ""
        },
        native: {}
      });
      this.setState("info.remotesConnected", "", true);
      this.remoteSensorServer = new import_remote_server.RemoteSensorServer(this.config.remotePort, this.config.remoteKey, this);
      this.remoteSensorServer.on("listening", () => {
        this.log.info(`Remote sensor server is listening on port ${this.config.remotePort}`);
        this.updateInfoConnection();
      });
      this.remoteSensorServer.on("error", (err) => {
        this.log.warn(`Remote sensor server error: ${err.toString()}`);
        this.log.debug(`${err.toString()} ${err.stack}`);
        this.updateInfoConnection();
      });
      this.remoteSensorServer.on("remotesChanged", (remotes) => {
        this.setState("info.remotesConnected", remotes.join(","), true);
      });
    } else {
      if (await this.getObjectAsync("info.remotesConnected")) {
        await this.delObjectAsync("info.remotesConnected");
      }
    }
    if (!Array.isArray(this.config.sensors)) {
      this.config.sensors = [];
    }
    for (const sensorCfg of this.config.sensors) {
      if (!/^[0-9a-f]{2}-[0-9a-f]{12}$/.test(sensorCfg.address)) {
        this.log.warn(`Invalid sensor address configured: ${sensorCfg.address}`);
        continue;
      }
      if (this.sensors[sensorCfg.address]) {
        this.log.warn(`Sensor ${sensorCfg.address} is configured twice! Ignoring the all expect the first.`);
        continue;
      }
      if (sensorCfg.remoteSystemId && !this.config.remoteEnabled) {
        this.log.warn(`Sensor ${sensorCfg.address} is configured as remote sensor of ${sensorCfg.remoteSystemId} but remote sensors are not enabled!`);
        continue;
      }
      const name = sensorCfg.name || sensorCfg.address;
      await this.extendObjectAsync(`sensors.${sensorCfg.address}`, {
        type: "state",
        common: {
          name: sensorCfg.enabled ? name : import_i18n.i18n.getStringOrTranslated("%s (disabled)", name),
          type: "number",
          role: "value.temperature",
          unit: sensorCfg.unit || "\xB0C",
          read: true,
          write: false,
          def: null,
          icon: sensorCfg.enabled ? "ds18b20.png" : "sensor_disabled.png"
        },
        native: {}
      });
      if (!sensorCfg.enabled) {
        this.log.debug(`Sensor ${sensorCfg.address} is not enabled`);
        continue;
      }
      let interval;
      if (typeof sensorCfg.interval === "number") {
        interval = sensorCfg.interval;
      } else if (typeof sensorCfg.interval === "string" && sensorCfg.interval.length > 0) {
        interval = parseInt(sensorCfg.interval, 10);
        if (isNaN(interval)) {
          this.log.warn(`Query interval for sensor ${sensorCfg.address} is invalid! Using default.`);
          interval = this.config.defaultInterval;
        }
      } else {
        interval = this.config.defaultInterval;
      }
      this.sensors[sensorCfg.address] = new import_sensor.Sensor({
        w1DevicesPath: this.config.w1DevicesPath,
        address: sensorCfg.address,
        interval,
        nullOnError: !!sensorCfg.nullOnError,
        factor: typeof sensorCfg.factor === "number" ? sensorCfg.factor : 1,
        offset: typeof sensorCfg.offset === "number" ? sensorCfg.offset : 0,
        decimals: typeof sensorCfg.decimals === "number" ? sensorCfg.decimals : null,
        remoteSystemId: typeof sensorCfg.remoteSystemId === "string" ? sensorCfg.remoteSystemId : null
      }, this);
      this.sensors[sensorCfg.address].on("value", this.handleSensorValue);
      this.sensors[sensorCfg.address].on("error", this.handleSensorError);
      this.sensors[sensorCfg.address].on("errorStateChanged", this.handleSensorErrorStateChanged);
    }
    const count = Object.keys(this.sensors).length;
    this.log.debug(`Loaded ${count} enabled sensors`);
    if (count === 0) {
      this.log.warn("No sensors configured or enabled!");
    }
    const objListSensors = await this.getObjectListAsync({
      startkey: `${this.namespace}.sensors.`,
      endkey: `${this.namespace}.sensors.\u9999`
    });
    const reAddress = new RegExp(`^${this.name}\\.${this.instance}\\.sensors\\.(.+)$`);
    for (const item of objListSensors.rows) {
      const m = item.id.match(reAddress);
      if (m) {
        const addr = m[1];
        if (!this.config.sensors.find((s) => s.address === addr)) {
          this.log.info(`Delete object ${item.id} since sensor is not configured`);
          await this.delObjectAsync(item.id);
        }
      }
    }
    this.subscribeStates("actions.*");
  }
  async onUnload(callback) {
    try {
      for (const address in this.sensors) {
        this.sensors[address].stop();
      }
      if (this.remoteSensorServer) {
        await this.remoteSensorServer.stop();
        await this.setStateAsync("info.remotesConnected", "", true);
      }
      if (!this.doingMigration) {
        await this.setStateAsync("info.connection", false, true);
      }
    } catch (e) {
    }
    callback();
  }
  handleSensorValue(value, address) {
    if (!this.sensors[address])
      return;
    this.log.debug(`Got value ${value} from sensor ${address}`);
    if (value === null) {
      this.setStateAsync(`sensors.${address}`, {
        ack: true,
        val: null,
        q: 129
      });
    } else {
      this.setStateAsync(`sensors.${address}`, {
        ack: true,
        val: value
      });
    }
  }
  handleSensorError(err, address) {
    this.log.warn(`Error reading sensor ${address}: ${err}`);
  }
  handleSensorErrorStateChanged(hasError, address) {
    this.log.debug(`Error state of sensor ${address} changed to ${hasError}`);
    this.extendObjectAsync(`sensors.${address}`, {
      common: {
        icon: hasError ? "sensor_error.png" : "sensor_ok.png"
      }
    });
    this.updateInfoConnection();
  }
  updateInfoConnection() {
    if (this.remoteSensorServer && !this.remoteSensorServer.isListening()) {
      this.setStateAsync("info.connection", false, true);
      return;
    }
    if (Object.keys(this.sensors).length === 0) {
      this.setStateAsync("info.connection", false, true);
      return;
    }
    for (const address in this.sensors) {
      if (this.sensors[address].hasError) {
        this.setStateAsync("info.connection", false, true);
        return;
      }
    }
    this.setStateAsync("info.connection", true, true);
  }
  getSensor(idOrAddress) {
    if (this.sensors[idOrAddress])
      return this.sensors[idOrAddress];
    const m = /^ds18b20\.\d+\.sensors\.(.+)$/.exec(idOrAddress);
    if (m && this.sensors[m[1]]) {
      return this.sensors[m[1]];
    }
    return null;
  }
  async readNow(idOrAddress) {
    if (typeof idOrAddress !== "string" || idOrAddress === "all" || idOrAddress === "") {
      this.log.info(`Read data from all sensors now`);
      const results = {};
      for (const address in this.sensors) {
        try {
          results[address] = await this.sensors[address].read();
        } catch (err) {
          results[address] = null;
        }
      }
      return results;
    } else {
      const sens = this.getSensor(idOrAddress);
      if (!sens) {
        this.log.warn(`No sensor with address or id ${idOrAddress} found!`);
        return null;
      }
      this.log.info(`Read data from sensor ${sens.address} now`);
      return await sens.read();
    }
  }
  async searchSensors() {
    const sensors = [];
    try {
      const files = await (0, import_promises.readdir)(this.config.w1DevicesPath);
      const proms = [];
      for (const file of files) {
        if (/^w1_bus_master\d+$/.test(file)) {
          this.log.debug(`Reading ${this.config.w1DevicesPath}/${file}/w1_master_slaves`);
          proms.push((0, import_promises.readFile)(`${this.config.w1DevicesPath}/${file}/w1_master_slaves`, "utf8"));
        } else if (file === "w1_master_slaves") {
          this.log.debug(`Reading ${this.config.w1DevicesPath}/w1_master_slaves`);
          proms.push((0, import_promises.readFile)(`${this.config.w1DevicesPath}/w1_master_slaves`, "utf8"));
        }
      }
      const localSensors = (await Promise.all(proms)).reduce((acc, cur) => {
        acc.push(...cur.trim().split("\n"));
        return acc;
      }, []).map((addr) => ({ address: addr, remoteSystemId: "" }));
      sensors.push(...localSensors);
    } catch (er) {
      this.log.warn(`Error while searching for local sensors: ${er.toString()}`);
    }
    if (this.config.remoteEnabled && this.remoteSensorServer) {
      try {
        const remoteSensors = await this.remoteSensorServer.search();
        sensors.push(...remoteSensors);
      } catch (er) {
        this.log.warn(`Error while searching for remote sensors: ${er.toString()}`);
      }
    }
    this.log.debug(`Sensors found: ${JSON.stringify(sensors)}`);
    return sensors;
  }
  async onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }
    if (id === `${this.namespace}.actions.readNow`) {
      await this.readNow(state.val).catch(() => {
      });
      await this.setStateAsync(this.namespace + ".actions.readNow", "", true);
    }
  }
  async onMessage(obj) {
    var _a;
    this.log.debug("Got message " + JSON.stringify(obj));
    if (typeof obj === "object") {
      switch (obj.command) {
        case "read":
        case "readNow":
          try {
            const value = typeof obj.message === "string" ? await this.readNow(obj.message) : await this.readNow();
            if (obj.callback) {
              this.sendTo(obj.from, obj.command, { err: null, value }, obj.callback);
            }
            return;
          } catch (err) {
            this.log.debug(err.toString());
            if (obj.callback) {
              this.sendTo(obj.from, obj.command, { err: err.toString(), value: null }, obj.callback);
            }
          }
          break;
        case "getRemoteSystems":
          if (!obj.callback)
            return;
          if (!this.remoteSensorServer) {
            this.sendTo(obj.from, obj.command, [], obj.callback);
            return;
          }
          this.sendTo(obj.from, obj.command, this.remoteSensorServer.getConnectedSystems(), obj.callback);
          break;
        case "getRemoteSystemsAdminUi":
          if (!obj.callback)
            return;
          let remotes = (_a = this.remoteSensorServer) == null ? void 0 : _a.getConnectedSystems().join(", ");
          if (!remotes) {
            remotes = "---";
          }
          this.sendTo(obj.from, obj.command, remotes, obj.callback);
          break;
        case "search":
        case "searchSensors":
          if (!obj.callback)
            return;
          this.sendTo(obj.from, obj.command, { sensors: await this.searchSensors() }, obj.callback);
          break;
        case "searchSensorsAdminUi":
          if (!obj.callback)
            return;
          const sensors = [];
          if (typeof obj.message === "object" && Array.isArray(obj.message.sensors)) {
            sensors.push(...obj.message.sensors);
          }
          const foundSensors = await this.searchSensors();
          for (const foundSensor of foundSensors) {
            if (sensors.findIndex((cfgSensor) => cfgSensor.address === foundSensor.address && cfgSensor.remoteSystemId === foundSensor.remoteSystemId) < 0) {
              sensors.push({
                address: foundSensor.address,
                remoteSystemId: foundSensor.remoteSystemId,
                name: "",
                interval: null,
                unit: "\xB0C",
                factor: 1,
                offset: 0,
                decimals: 2,
                nullOnError: true,
                enabled: true
              });
            }
          }
          this.sendTo(obj.from, obj.command, { native: { sensors } }, obj.callback);
          break;
        case "getNewRemoteKey":
          if (!obj.callback)
            return;
          this.sendTo(obj.from, obj.command, { native: { remoteKey: (0, import_utils.genHexString)(64) } }, obj.callback);
          break;
      }
    }
  }
}
__decorateClass([
  import_autobind_decorator.boundMethod
], Ds18b20Adapter.prototype, "onReady", 1);
__decorateClass([
  import_autobind_decorator.boundMethod
], Ds18b20Adapter.prototype, "onUnload", 1);
__decorateClass([
  import_autobind_decorator.boundMethod
], Ds18b20Adapter.prototype, "handleSensorValue", 1);
__decorateClass([
  import_autobind_decorator.boundMethod
], Ds18b20Adapter.prototype, "handleSensorError", 1);
__decorateClass([
  import_autobind_decorator.boundMethod
], Ds18b20Adapter.prototype, "handleSensorErrorStateChanged", 1);
__decorateClass([
  import_autobind_decorator.boundMethod
], Ds18b20Adapter.prototype, "onStateChange", 1);
__decorateClass([
  import_autobind_decorator.boundMethod
], Ds18b20Adapter.prototype, "onMessage", 1);
if (require.main !== module) {
  module.exports = (options) => new Ds18b20Adapter(options);
} else {
  (() => new Ds18b20Adapter())();
}
//# sourceMappingURL=main.js.map
