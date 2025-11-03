import _ from '@env-spec/utils/my-dash';

import { FileBasedDataSource, type EnvGraphDataSource } from './data-source';
import type { VarlockErrorLocationDetails } from './errors';

export function getErrorLocation(source: EnvGraphDataSource, parserNode: any): VarlockErrorLocationDetails | undefined {
  if (!(source instanceof FileBasedDataSource)) return;
  if (!parserNode.data || !parserNode.data._location || !_.isNumber(parserNode.data._location.start.line)) return;
  const lineNumber = parserNode.data._location?.start.line as number;
  const colNumber = parserNode.data._location?.start.column as number;
  return {
    id: source.fullPath,
    lineNumber,
    colNumber,
    lineStr: source.rawContents?.split('\n')[lineNumber - 1]?.trim() || '',
  };
}
