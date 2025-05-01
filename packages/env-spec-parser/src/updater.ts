import { parseEnvSpecDotEnvFile } from './index';
import {
  ParsedEnvSpecComment, ParsedEnvSpecCommentBlock, ParsedEnvSpecConfigItem, ParsedEnvSpecDecoratorComment,
  ParsedEnvSpecDivider, ParsedEnvSpecFile,
} from './classes';

function ensureHeader(file: ParsedEnvSpecFile, newHeaderContents?: string) {
  // update utils
  if (!file.header) {
    newHeaderContents ||= 'This env file uses @env-spec - see https://varlock.dev/env-spec for more info';
    file.contents.unshift(
      // header is a comment block at the beginning of the file and must end with a divider
      new ParsedEnvSpecCommentBlock({
        // we'll break up the passed in content and add a comment line for each
        comments: newHeaderContents.split('\n').map((line) => (
          new ParsedEnvSpecComment({ contents: line, leadingSpace: ' ' })
        )),
        divider: new ParsedEnvSpecDivider({ contents: '----------', leadingSpace: ' ' }),
      }),
    );
  }
}

// internal helper to create a new decorator node rather than constructing manually
function createDummyDecoratorNode(
  decoratorName: string,
  valueStr: string,
  isBareFnArgs?: boolean,
) {
  // we'll use the parser to generate a new decorator value node correctly
  // rather than trying to do it ourselves
  let decStr = `@${decoratorName}`;
  if (isBareFnArgs) decStr += `(${valueStr})`;
  else if (valueStr !== 'true') {
    decStr += `=${valueStr}`;
  }
  const parsed = parseEnvSpecDotEnvFile(`# ${decStr}`);
  const newDecNode = parsed.decoratorsObject[decoratorName];
  if (!newDecNode) throw new Error('Creating new decorator failed');
  return newDecNode;
}

function setRootDecorator(
  file: ParsedEnvSpecFile,
  decoratorName: string,
  valueStr: string,
  isBareFnArgs?: boolean,
) {
  ensureHeader(file);

  const newDecNode = createDummyDecoratorNode(decoratorName, valueStr, isBareFnArgs);

  const existingDecorator = file.decoratorsObject[decoratorName];
  if (existingDecorator) {
    existingDecorator.data.valueOrFnArgs = newDecNode.data.valueOrFnArgs;
  } else {
    if (!file.header) throw new Error('No header found');
    const lastComment = file.header.data.comments[file.header.data.comments.length - 1];
    let decCommentLine: ParsedEnvSpecDecoratorComment;
    if (lastComment instanceof ParsedEnvSpecDecoratorComment && lastComment.toString().length < 40) {
      decCommentLine = lastComment;
    } else {
      decCommentLine = new ParsedEnvSpecDecoratorComment({
        decorators: [],
        leadingSpace: ' ',
      });
      file.header.data.comments.push(decCommentLine);
    }
    decCommentLine.decorators.push(newDecNode);
  }
}

function setItemDecorator(
  file: ParsedEnvSpecFile,
  key: string,
  decoratorName: string,
  valueStr: string,
  isBareFnArgs?: boolean,
) {
  let item = file.configItems.find((i) => i.key === key);
  if (!item) {
    item = new ParsedEnvSpecConfigItem({
      key, value: undefined, preComments: [], postComment: undefined,
    });
    file.contents.push(item);
  }

  const newDecNode = createDummyDecoratorNode(decoratorName, valueStr, isBareFnArgs);

  const existingDecorator = item.decoratorsObject[decoratorName];
  if (existingDecorator) {
    existingDecorator.data.valueOrFnArgs = newDecNode.data.valueOrFnArgs;
  } else {
    const lastComment = item.data.preComments[item.data.preComments.length - 1];
    let decCommentLine: ParsedEnvSpecDecoratorComment;
    if (lastComment instanceof ParsedEnvSpecDecoratorComment && lastComment.toString().length < 40) {
      decCommentLine = lastComment;
    } else {
      decCommentLine = new ParsedEnvSpecDecoratorComment({
        decorators: [],
        leadingSpace: ' ',
      });
      item.data.preComments.push(decCommentLine);
    }
    decCommentLine.decorators.push(newDecNode);
  }
}

export const envSpecUpdater = {
  ensureHeader,
  setRootDecorator,
  setItemDecorator,
};
