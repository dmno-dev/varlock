/**
 * Register custom SVG icons with @iconify/vue so they can be used
 * via `<Icon icon="opencode-logo" />` in Vue components.
 *
 * Import this module for its side-effects before rendering any Vue
 * component that references these icon names.
 */
import { addIcon } from '@iconify/vue';

import opencodeSvg from '../icons/opencode-logo.svg?raw';
import akeylessSvg from '../icons/akeyless-logo.svg?raw';
import dopplerSvg from '../icons/doppler-logo.svg?raw';

function registerSvgIcon(name: string, raw: string) {
  const viewBoxMatch = raw.match(/viewBox="([^"]+)"/);
  const [,, w, h] = viewBoxMatch![1].split(/\s+/).map(Number);
  // extract inner content of the <svg> element
  const body = raw.replace(/^[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  addIcon(name, { body, width: w, height: h });
}

registerSvgIcon('opencode-logo', opencodeSvg);
registerSvgIcon('akeyless-logo', akeylessSvg);
registerSvgIcon('doppler-logo', dopplerSvg);
