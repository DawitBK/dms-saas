import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<string>;
  declare email: string;
  declare passwordHash: string | null;
  declare firstName: string;
  declare lastName: string;
  declare isActive: CreationOptional<boolean>;
  declare isMfaEnabled: CreationOptional<boolean>;
  declare mfaSecret: string | null;
  declare mfaTempSecret: string | null;
  declare mustChangePassword: CreationOptional<boolean>;
  declare passwordChangedAt: Date | null;
  declare lastLoginAt: Date | null;
  declare failedLoginCount: CreationOptional<number>;
  declare lockedUntil: Date | null;
  // External identity subject from the OIDC IdP (stable `sub`), set on JIT
  // provisioning via /auth/callback. Null for locally-created users.
  declare externalSub: CreationOptional<string | null>;
  // D8c: optional handwritten-signature image (data URL), rendered in letter
  // signatory blocks and e-sign ceremonies.
  declare signatureImage: CreationOptional<string | null>;
  // D10: executive opt-out from approved-letter notice emails.
  declare execNoticeOptOut: CreationOptional<boolean>;
  // L3: user-controlled email preferences ({ emailOnWorkflow?, emailOnLegalHold?,
  // emailOnSystem? }). Only work-reminder emails honor these; compliance and
  // external-recipient emails never do.
  declare notificationPrefs: CreationOptional<Record<string, boolean>>;
  // True once a DMS admin has assigned/removed this user's roles via DMS's
  // own admin UI (users.service.ts's assignRole/removeRole) -- tells the
  // OIDC callback (auth.service.ts) to keep that edit instead of silently
  // reverting it to the SSO id_token's roles claim on the next login.
  declare rolesManagedLocally: CreationOptional<boolean>;
  // The role-name set the SSO id_token claim (or its ad_groups ->
  // idp_role_mappings fallback) last actually asserted for this user, at the
  // last login where it won. Compared against the CURRENT claim so a login
  // can tell a genuine SSO-side mapping change (claim differs -- let it win)
  // apart from an unchanged claim under an active local override (claim
  // matches -- the local edit stands).
  declare ssoRolesSnapshot: CreationOptional<string[] | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;
}

export function initUser() {
  User.init(
    {
      id: uuidPk,
      email: { type: DataTypes.STRING(255), allowNull: false, unique: true },
      passwordHash: DataTypes.STRING(255),
      firstName: { type: DataTypes.STRING(100), allowNull: false },
      lastName: { type: DataTypes.STRING(100), allowNull: false },
      isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
      isMfaEnabled: { type: DataTypes.BOOLEAN, defaultValue: false },
      mfaSecret: DataTypes.STRING(255),
      mfaTempSecret: DataTypes.STRING(255),
      mustChangePassword: { type: DataTypes.BOOLEAN, defaultValue: false },
      passwordChangedAt: DataTypes.DATE,
      lastLoginAt: DataTypes.DATE,
      failedLoginCount: { type: DataTypes.INTEGER, defaultValue: 0 },
      lockedUntil: DataTypes.DATE,
      externalSub: { type: DataTypes.STRING(255), allowNull: true, field: "external_sub" },
      signatureImage: { type: DataTypes.TEXT, allowNull: true, field: "signature_image" },
      execNoticeOptOut: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "exec_notice_opt_out" },
      notificationPrefs: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: "notification_prefs" },
      rolesManagedLocally: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "roles_managed_locally" },
      ssoRolesSnapshot: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: true, field: "sso_roles_snapshot" },
      deletedAt: DataTypes.DATE,
      createdAt: { type: DataTypes.DATE, field: "created_at" },
      updatedAt: { type: DataTypes.DATE, field: "updated_at" }
    },
    { sequelize, tableName: "users", timestamps: true, paranoid: false, underscored: true}
  );
}
