import { EventEmitter } from 'events';
import { readPacket, PacketType, HEADER, assertPacket, MessageType } from './atorch-packet';
import Bluetooth from 'node-web-bluetooth';

// const UUID_SERVICE = '0000ffe0-0000-1000-8000-00805f9b34fb';
const UUID_SERVICE = 0xffe0;
// const UUID_CHARACTERISTIC = '0000ffe1-0000-1000-8000-00805f9b34fb';
const UUID_CHARACTERISTIC = 0xffe1;

const DISCONNECTED = 'gattserverdisconnected';
const VALUE_CHANGED = 'characteristicvaluechanged';

const EVENT_FAILED = 'failed';
const EVENT_PACKET = 'packet';

interface Events {
  disconnected(disconnected: boolean): void;
  failed(packet: Buffer): void;
  packet(packet: PacketType): void;
}


class SelectFirstFoundDevice extends Bluetooth.RequestDeviceDelegate {

  private _timer;
  private resolve;
  private reject;

  // Select first device found
  onAddDevice(device) {
    // console.log(device.toString());
    // console.log(JSON.stringify(device));
    this.resolve(device);
  }
  onUpdateDevice(device) {
    // Called whenever new advertisement data was received
    // for the device
    // console.log(device);
  }

  // Time-out when device hasn't been found in 20 secs
  onStartScan() {
    this._timer = setTimeout(() => {
      this.reject(new Error('No device found'));
      process.exit();
    }, 20000);
  }
  onStopScan() {
    if (this._timer) clearTimeout(this._timer);
  }
}

export class AtorchService {
  public static async requestDevice() {
    const device = await Bluetooth.requestDevice({
      filters: [{ services: [UUID_SERVICE] }],
      delegate: new SelectFirstFoundDevice()
    });
    return new AtorchService(device);
  }

  private blocks: Buffer[] = [];
  private events = new EventEmitter();
  private device: Bluetooth;

  private constructor(device: Bluetooth) {
    this.device = device;
    device.addEventListener(DISCONNECTED, () => {
      this.events.emit('disconnected', false);
    });
  }

  public async connect() {
    const characteristic = await this.getCharacteristic();
    characteristic?.addEventListener(VALUE_CHANGED, this.handleValueChanged);
    await characteristic?.startNotifications();
  }

  public async disconnect() {
    try {
      this.device.gatt?.disconnect();
    } catch {
      // ignore
    }
    this.events.removeAllListeners();
  }

  public async sendCommand(block: Buffer) {
    assertPacket(block, MessageType.Command);
    const characteristic = await this.getCharacteristic();
    await characteristic?.writeValue(block);
  }

  private getCharacteristic = async () => {
    const server = await this.device.gatt?.connect();
    const service = await server?.getPrimaryService(UUID_SERVICE);
    return service?.getCharacteristic(UUID_CHARACTERISTIC);
  };

  public on<K extends keyof Events>(event: K, listener: Events[K]): () => void;
  public on(event: string, listener: (...args: unknown[]) => void) {
    this.events.on(event, listener);
    return () => {
      this.events.off(event, listener);
    };
  }

  private handleValueChanged = (event: any) => {
  //   const target = event.target as BluetoothRemoteGATTCharacteristic;
    const target = event.target;
    const payload = Buffer.from(target.value?.buffer ?? []);
    if (payload.indexOf(HEADER) === 0) {
      if (this.blocks.length !== 0) {
        this.emitBlock(Buffer.concat(this.blocks));
      }
      this.blocks = [payload];
    } else {
      this.blocks.push(payload);
    }
  };


  private emitBlock(block: Buffer) {
    // console.log('Block', block.toString('hex').toUpperCase());
    try {
      const packet = readPacket(block);
      this.events.emit(EVENT_PACKET, packet);
    } catch {
      this.events.emit(EVENT_FAILED, block);
    }
  }
}
