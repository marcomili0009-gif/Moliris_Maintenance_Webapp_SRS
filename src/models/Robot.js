import mongoose from 'mongoose';

const robotSchema = new mongoose.Schema(
  {
    robot_id: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    display_name: {
      type: String,
      required: true,
      trim: true
    },
    remote_username: {
      type: String,
      required: true,
      trim: true
    },
    host: {
      type: String,
      required: true,
      trim: true
    },
    ssh_port: {
      type: Number,
      default: 22,
      min: 1,
      max: 65535
    },
    auth_method: {
      type: String,
      enum: ['password', 'key'],
      required: true
    },
    key_reference: {
      type: String,
      default: null
    },
    host_key_fingerprint: {
      type: String,
      default: null
    },
    status_file_path: {
      type: String,
      default: '/var/log/moliris/status.json'
    },
    server_directory: {
      type: String,
      required: true
    },
    connection_status: {
      type: String,
      enum: ['online', 'offline', 'unverified'],
      default: 'unverified'
    },
    last_connection_attempt: {
      type: Date,
      default: null
    },
    operational_state: {
      type: String,
      default: 'unknown'
    },
    last_operational_update: {
      type: Date,
      default: null
    },
    last_state_data: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  {
    timestamps: true
  }
);

// Indice univoco per evitare collisioni su stesso utente, host e porta
robotSchema.index(
  { remote_username: 1, host: 1, ssh_port: 1 },
  { unique: true }
);

export const Robot = mongoose.model('Robot', robotSchema);
