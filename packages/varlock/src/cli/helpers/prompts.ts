// this is a slightly modified version of @clack/prompts
// mostly to remove the additional left border

import type { Readable, Writable } from 'node:stream';
import { WriteStream } from 'node:tty';
import {
  ConfirmPrompt, SelectPrompt, MultiSelectPrompt, type State,
} from '@clack/core';
import color from 'ansis';
import isUnicodeSupported from 'is-unicode-supported';

const unicode = isUnicodeSupported();
const isCI = (): boolean => process.env.CI === 'true';
const unicodeOr = (c: string, fallback: string) => (unicode ? c : fallback);
const S_STEP_ACTIVE = unicodeOr('◆', '*');
const S_STEP_CANCEL = unicodeOr('■', 'x');
const S_STEP_ERROR = unicodeOr('▲', 'x');
const S_STEP_SUBMIT = unicodeOr('◇', 'o');

const S_BAR_START = unicodeOr('┌', 'T');
const S_BAR = unicodeOr('│', '|');
const S_BAR_END = unicodeOr('└', '—');

const S_RADIO_ACTIVE = unicodeOr('●', '>');
const S_RADIO_INACTIVE = unicodeOr('○', ' ');
const S_CHECKBOX_ACTIVE = unicodeOr('◻', '[•]');
const S_CHECKBOX_SELECTED = unicodeOr('◼', '[+]');
const S_CHECKBOX_INACTIVE = unicodeOr('◻', '[ ]');
const S_PASSWORD_MASK = unicodeOr('▪', '•');

const S_BAR_H = unicodeOr('─', '-');
const S_CORNER_TOP_RIGHT = unicodeOr('╮', '+');
const S_CONNECT_LEFT = unicodeOr('├', '+');
const S_CORNER_BOTTOM_RIGHT = unicodeOr('╯', '+');

const S_INFO = unicodeOr('●', '•');
const S_SUCCESS = unicodeOr('◆', '*');
const S_WARN = unicodeOr('▲', '!');
const S_ERROR = unicodeOr('■', 'x');

const symbol = (state: State) => {
  // eslint-disable-next-line default-case
  switch (state) {
    case 'initial':
    case 'active':
      return color.cyan(S_STEP_ACTIVE);
    case 'cancel':
      return color.red(S_STEP_CANCEL);
    case 'error':
      return color.yellow(S_STEP_ERROR);
    case 'submit':
      return color.green(S_STEP_SUBMIT);
  }
};

export interface CommonOptions {
  input?: Readable;
  output?: Writable;
}




/// /
export interface LimitOptionsParams<TOption> extends CommonOptions {
  options: Array<TOption>;
  maxItems: number | undefined;
  cursor: number;
  style: (option: TOption, active: boolean) => string;
}

export const limitOptions = <TOption>(params: LimitOptionsParams<TOption>): Array<string> => {
  const { cursor, options, style } = params;
  const output: Writable = params.output ?? process.stdout;
  const rows = output instanceof WriteStream && output.rows !== undefined ? output.rows : 10;

  const paramMaxItems = params.maxItems ?? Number.POSITIVE_INFINITY;
  const outputMaxItems = Math.max(rows - 4, 0);
  // We clamp to minimum 5 because anything less doesn't make sense UX wise
  const maxItems = Math.min(outputMaxItems, Math.max(paramMaxItems, 5));
  let slidingWindowLocation = 0;

  if (cursor >= slidingWindowLocation + maxItems - 3) {
    slidingWindowLocation = Math.max(Math.min(cursor - maxItems + 3, options.length - maxItems), 0);
  } else if (cursor < slidingWindowLocation + 2) {
    slidingWindowLocation = Math.max(cursor - 2, 0);
  }

  const shouldRenderTopEllipsis = maxItems < options.length && slidingWindowLocation > 0;
  const shouldRenderBottomEllipsis = maxItems < options.length && slidingWindowLocation + maxItems < options.length;

  return options
    .slice(slidingWindowLocation, slidingWindowLocation + maxItems)
    .map((option, i, arr) => {
      const isTopLimit = i === 0 && shouldRenderTopEllipsis;
      const isBottomLimit = i === arr.length - 1 && shouldRenderBottomEllipsis;
      return isTopLimit || isBottomLimit
        ? color.dim('...')
        : style(option, i + slidingWindowLocation === cursor);
    });
};


///

export interface ConfirmOptions extends CommonOptions {
  message: string;
  active?: string;
  inactive?: string;
  initialValue?: boolean;
}
export const confirm = (opts: ConfirmOptions) => {
  const active = opts.active ?? 'Yes';
  const inactive = opts.inactive ?? 'No';
  return new ConfirmPrompt({
    active,
    inactive,
    input: opts.input,
    output: opts.output,
    initialValue: opts.initialValue ?? true,
    render() {
      const title = `\n${symbol(this.state)} ${opts.message}\n`;
      const value = this.value ? active : inactive;

      // NOTE it's trimming leading spaces, so we use an invisible character at the beginnign of the line to add some spacing
      switch (this.state) {
        case 'submit':
          return `${title}‎ ${color.dim(value)}`;
        case 'cancel':
          return `${title}‎ ${color.strikethrough(
            color.dim(value),
          )}\n`;
        default: {
          return `${title}‎ ${
            this.value
              ? `${color.green(S_RADIO_ACTIVE)} ${active}`
              : `${color.dim(S_RADIO_INACTIVE)} ${color.dim(active)}`
          } ${color.dim('/')} ${
            !this.value
              ? `${color.green(S_RADIO_ACTIVE)} ${inactive}`
              : `${color.dim(S_RADIO_INACTIVE)} ${color.dim(inactive)}`
          }\n`;
        }
      }
    },
  }).prompt() as Promise<boolean | symbol>;
};



type Primitive = Readonly<string | boolean | number>;

export type Option<Value> = Value extends Primitive
  ? {
    /**
     * Internal data for this option.
     */
    value: Value;
    /**
     * The optional, user-facing text for this option.
     *
     * By default, the `value` is converted to a string.
     */
    label?: string;
    /**
     * An optional hint to display to the user when
     * this option might be selected.
     *
     * By default, no `hint` is displayed.
     */
    hint?: string;
  }
  : {
    /**
     * Internal data for this option.
     */
    value: Value;
    /**
     * Required. The user-facing text for this option.
     */
    label: string;
    /**
     * An optional hint to display to the user when
     * this option might be selected.
     *
     * By default, no `hint` is displayed.
     */
    hint?: string;
  };

export interface SelectOptions<Value> extends CommonOptions {
  message: string;
  options: Array<Option<Value>>;
  initialValue?: Value;
  maxItems?: number;
}

export const select = <Value>(opts: SelectOptions<Value>) => {
  const opt = (option: Option<Value>, state: 'inactive' | 'active' | 'selected' | 'cancelled') => {
    const label = option.label ?? String(option.value);
    switch (state) {
      case 'selected':
        return `${color.dim(label)}`;
      case 'active':
        return `${color.green(S_RADIO_ACTIVE)} ${label} ${
          option.hint ? color.dim(`(${option.hint})`) : ''
        }`;
      case 'cancelled':
        return `${color.strikethrough(color.dim(label))}`;
      default:
        return `${color.dim(S_RADIO_INACTIVE)} ${color.dim(label)}`;
    }
  };

  return new SelectPrompt({
    options: opts.options,
    input: opts.input,
    output: opts.output,
    initialValue: opts.initialValue,
    render() {
      const title = `${color.gray(S_BAR)}\n${symbol(this.state)}  ${opts.message}\n`;

      switch (this.state) {
        case 'submit':
          return `${title}${color.gray(S_BAR)}  ${opt(this.options[this.cursor], 'selected')}`;
        case 'cancel':
          return `${title}${color.gray(S_BAR)}  ${opt(
            this.options[this.cursor],
            'cancelled',
          )}\n${color.gray(S_BAR)}`;
        default: {
          return `${title}${color.cyan(S_BAR)}  ${limitOptions({
            output: opts.output,
            cursor: this.cursor,
            options: this.options,
            maxItems: opts.maxItems,
            style: (item, active) => opt(item, active ? 'active' : 'inactive'),
          }).join(`\n${color.cyan(S_BAR)}  `)}\n${color.cyan(S_BAR_END)}\n`;
        }
      }
    },
  }).prompt() as Promise<Value | symbol>;
};


export interface MultiSelectOptions<Value> extends CommonOptions {
  message: string;
  details?: string;
  options: Array<Option<Value>>;
  initialValues?: Array<Value>;
  maxItems?: number;
  required?: boolean;
  cursorAt?: Value;
}
export const multiselect = <Value>(opts: MultiSelectOptions<Value>) => {
  const opt = (
    option: Option<Value>,
    state: 'inactive' | 'active' | 'selected' | 'active-selected' | 'submitted' | 'cancelled',
  ) => {
    const label = option.label ?? String(option.value);
    if (state === 'active') {
      return `${color.cyan(S_CHECKBOX_ACTIVE)} ${label} ${
        option.hint ? color.dim(`(${option.hint})`) : ''
      }`;
    }
    if (state === 'selected') {
      return `${color.green(S_CHECKBOX_SELECTED)} ${color.dim(label)} ${
        option.hint ? color.dim(`(${option.hint})`) : ''
      }`;
    }
    if (state === 'cancelled') {
      return `${color.strikethrough(color.dim(label))}`;
    }
    if (state === 'active-selected') {
      return `${color.green(S_CHECKBOX_SELECTED)} ${label} ${
        option.hint ? color.dim(`(${option.hint})`) : ''
      }`;
    }
    if (state === 'submitted') {
      return `${color.dim(label)}`;
    }
    return `${color.dim(S_CHECKBOX_INACTIVE)} ${color.dim(label)}`;
  };

  return new MultiSelectPrompt({
    options: opts.options,
    input: opts.input,
    output: opts.output,
    initialValues: opts.initialValues,
    required: opts.required ?? true,
    cursorAt: opts.cursorAt,
    validate(selected: Array<Value>) {
      if (this.required && selected.length === 0) {
        return `Please select at least one option.\n${color.reset(
          color.dim(
            `Press ${color.gray(color.bgWhite(color.inverse(' space ')))} to select, ${color.gray(
              color.bgWhite(color.inverse(' enter ')),
            )} to submit`,
          ),
        )}`;
      }
    },
    render() {
      let title = `${color.gray(S_BAR)}\n${symbol(this.state)}  ${opts.message}\n`;
      if (opts.details) title += `${color.gray(S_BAR)} ${opts.details}\n`;

      const styleOption = (option: Option<Value>, active: boolean) => {
        const selected = this.value.includes(option.value);
        if (active && selected) {
          return opt(option, 'active-selected');
        }
        if (selected) {
          return opt(option, 'selected');
        }
        return opt(option, active ? 'active' : 'inactive');
      };

      switch (this.state) {
        case 'submit': {
          return `${title}${color.gray(S_BAR)}  ${
            this.options
              .filter(({ value }) => this.value.includes(value))
              .map((option) => opt(option, 'submitted'))
              .join(color.dim(', ')) || color.dim('none')
          }`;
        }
        case 'cancel': {
          const label = this.options
            .filter(({ value }) => this.value.includes(value))
            .map((option) => opt(option, 'cancelled'))
            .join(color.dim(', '));
          return `${title}${color.gray(S_BAR)}  ${
            label.trim() ? `${label}\n${color.gray(S_BAR)}` : ''
          }`;
        }
        case 'error': {
          const footer = this.error
            .split('\n')
            .map((ln, i) => (i === 0 ? `${color.yellow(S_BAR_END)}  ${color.yellow(ln)}` : `   ${ln}`))
            .join('\n');
          return `${title + color.yellow(S_BAR)}  ${limitOptions({
            output: opts.output,
            options: this.options,
            cursor: this.cursor,
            maxItems: opts.maxItems,
            style: styleOption,
          }).join(`\n${color.yellow(S_BAR)}  `)}\n${footer}\n`;
        }
        default: {
          return `${title}${color.cyan(S_BAR)}  ${limitOptions({
            output: opts.output,
            options: this.options,
            cursor: this.cursor,
            maxItems: opts.maxItems,
            style: styleOption,
          }).join(`\n${color.cyan(S_BAR)}  `)}\n${color.cyan(S_BAR_END)}\n`;
        }
      }
    },
  }).prompt() as Promise<Array<Value> | symbol>;
};



/// ////

const prompts = {
  confirm,
  select,
  multiselect,
};

export default prompts;
