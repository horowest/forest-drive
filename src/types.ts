export interface ControlPayload {
  type: 'motion';
  steeringAngle: number;
  gas: boolean;
  brake: boolean;
  raw: {
    alpha: number;
    beta: number;
    gamma: number;
    ax: number;
    ay: number;
    az: number;
    rx: number;
    ry: number;
    rz: number;
    isSecureContext: boolean;
    activeApi: string;
  };
}

export const controllerState = {
  isPhoneConnected: false,
  steer: 0,
  gas: false,
  brake: false
};