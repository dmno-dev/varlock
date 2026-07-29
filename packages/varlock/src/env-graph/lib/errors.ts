import _ from '@env-spec/utils/my-dash';
// copied these error types from Astro
// and we will try to keep it compatible so we can interact with their error overlay

export type ErrorLocation = {
  file?: string;
  line?: number;
  column?: number;
};

/**
 * Generic object representing an error with all possible data
 * Compatible with both Astro's and Vite's errors
 */
export type ErrorWithMetadata = {
  [name: string]: any;
  name: string;
  title?: string;
  // type?: ErrorTypes; // these are astro's error types
  message: string;
  stack: string;
  hint?: string;
  id?: string;
  frame?: string;
  plugin?: string;
  pluginCode?: string;
  fullCode?: string;
  loc?: ErrorLocation;
  cause?: any;
};


export type VarlockErrorLocationDetails = {
  /** file path or url */
  id: string;
  /** 1-based line number */
  lineNumber: number;
  /** 1-based column number */
  colNumber: number;
  /** full line string */
  lineStr: string;
};


export type ErrorSeverity = 'warning' | 'error' | 'fatal';

export class VarlockError extends Error {
  originalError?: Error;
  get isUnexpected() { return !!this.originalError; }

  get type() { return this.name; }


  static defaultIcon = '❌';
  icon: string;

  /**
   * Stable machine-readable code for this error class, emitted as `code` in
   * serialized output so tools can branch on it instead of matching message
   * text. Set explicitly per subclass rather than derived from the class name,
   * so renaming a class can't silently change a published contract.
   */
  static defaultCode = 'unknown_error';

  private _severity: ErrorSeverity = 'error';

  constructor(errOrMessage: string | Error, readonly more?: {
    tip?: string | Array<string>,
    err?: Error,
    severity?: ErrorSeverity,
    /** @deprecated use severity: 'warning' instead */
    isWarning?: boolean,
    /** machine-friendly error code if needed for anything else */
    code?: string,
    location?: VarlockErrorLocationDetails,
    /** free-form additional metadata */
    extraMetadata?: Record<string, any>,
  }) {
    // super must be root level statement
    super(_.isError(errOrMessage) ? errOrMessage.message : errOrMessage);
    if (_.isError(errOrMessage)) {
      this.originalError = errOrMessage;
      this.icon = '💥';
    } else { // string
      this.originalError = more?.err;
    }
    if (_.isArray(more?.tip)) more.tip = more.tip.join('\n');
    this.name = this.constructor.name;
    if (more?.severity) {
      this.severity = more.severity;
    } else if (more?.isWarning) {
      this.severity = 'warning';
    }

    this.icon ||= (this.constructor as any).defaultIcon;
  }

  get tip() {
    if (!this.more?.tip) return undefined;
    if (_.isArray(this.more.tip)) return this.more.tip.join('\n');
    return this.more.tip;
  }

  get location() {
    return this.more?.location;
  }

  get code(): string {
    return this.more?.code ?? (this.constructor as typeof VarlockError).defaultCode;
  }
  get extraMetadata() {
    return this.more?.extraMetadata;
  }

  get severity() { return this._severity; }
  set severity(s: ErrorSeverity) {
    this._severity = s;
    if (s === 'warning') this.icon = '🧐';
  }

  get isWarning() { return this._severity === 'warning'; }
  set isWarning(w: boolean) { this.severity = w ? 'warning' : 'error'; }

  get isFatal() { return this._severity === 'fatal'; }

  toJSON() {
    return {
      icon: this.icon,
      type: this.type,
      name: this.name,
      code: this.code,
      message: this.message,
      severity: this.severity,
      isUnexpected: this.isUnexpected,
      ...this.tip && { tip: this.tip },
      ...this.isWarning && { isWarning: true },
    };
  }
}

export class ConfigLoadError extends VarlockError {
  static defaultCode = 'config_load_failed';
  readonly cleanedStack: Array<string>;
  constructor(err: Error) {
    super(err);

    // remove first line since its the error message
    let stackLines = (err.stack?.split('\n') || []).slice(1);
    stackLines = stackLines.filter((l) => {
      // filter out unimportant lines related to just running/loading
      // we could filter out more of dmno/core code once things stabilize
      //! these are probably not relevant anymore, or needs to move to a plugin layer?
      if (l.includes(' at ViteNodeRunner.')) return false;
      if (l.includes('core/src/config-loader/config-loader.ts')) return false;
      return true;
    });


    this.message = `${err.name}: ${err.message}`;



    this.cleanedStack = stackLines || [];
  }
  toJSON() {
    return {
      ...super.toJSON(),
      cleanedStack: this.cleanedStack,
    };
  }
}

export class LoadingError extends VarlockError {
  static defaultIcon = '📂';
  static defaultCode = 'loading_failed';
}
export class ParseError extends VarlockError {
  static defaultIcon = '😵‍💫';
  static defaultCode = 'parse_error';
}
export class SchemaError extends VarlockError {
  static defaultIcon = '🧰';
  static defaultCode = 'schema_error';
}
export class ValidationError extends VarlockError {
  static defaultIcon = '❌';
  static defaultCode = 'validation_failed';
}
export class CoercionError extends VarlockError {
  static defaultIcon = '🛑';
  static defaultCode = 'coercion_failed';
}
export class ResolutionError extends VarlockError {
  static defaultIcon = '⛔';
  static defaultCode = 'resolution_failed';
  protected _retryable?: boolean = false;
  set retryable(val: boolean) { this._retryable = val; }
  get retryable() {
    if (this._retryable) return true;
    if (this.originalError instanceof ResolutionError) return this.originalError.retryable;
    return false;
  }
}

export class EmptyRequiredValueError extends ValidationError {
  icon = '❓';
  static defaultCode = 'empty_required_value';
  constructor(_val: undefined | null | '') {
    super('Value is required but is currently empty');
  }
}

/**
 * No `.env*` files were found at all. A project does not need a `.env.schema`
 * (plain `.env` files are enough), but it does need at least one file to load.
 */
export class NoEnvFilesError extends VarlockError {
  static defaultIcon = '🚨';
  static defaultCode = 'no_env_files';
}

/**
 * Env files loaded, but they define no config items. Distinct from
 * `no_env_files` because the fix is different: add items, not create a file.
 */
export class NoConfigItemsError extends VarlockError {
  static defaultIcon = '🚨';
  static defaultCode = 'no_config_items';
}
