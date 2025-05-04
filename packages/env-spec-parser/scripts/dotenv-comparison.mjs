/* eslint-disable no-template-curly-in-string */

// comparison test suite from dotenvx
// see https://github.com/dotenvx/dotenvx.github.io/blob/main/_data/report.json

// we dont need everything to match 100% - but good to know what differences are

import util from 'node:util';
import { parseEnvSpecDotEnvFile } from '../dist/index.js';
const COMPARISON_SCENARIOS = {
  scenarios: [
    {
      scenario: '101_BASIC',
      env: 'BASIC=basic\n',
      expected: '{\n  "BASIC": "basic"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "BASIC": "basic"\n}',
        },
        docker: {
          pass: true,
          output: '{\n  "BASIC": "basic"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "BASIC": "basic"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "BASIC": "basic"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "BASIC": "basic"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "BASIC": "basic"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "BASIC": "basic"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "BASIC": "basic"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "BASIC": "basic"\n}',
        },
      },
    },
    {
      scenario: '102_EMPTY',
      env: 'EMPTY=\n',
      expected: '{\n  "EMPTY": ""\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        docker: {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
      },
    },
    {
      scenario: '103_MACHINE',
      env: 'MACHINE=file\n',
      expected: '{\n  "MACHINE": "machine"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "MACHINE": "machine"\n}',
        },
        docker: {
          pass: true,
          output: '{\n  "MACHINE": "machine"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "MACHINE": "machine"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "MACHINE": "machine"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "MACHINE": "machine"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "MACHINE": "machine"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "MACHINE": "machine"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '[]',
        },
        godotenv: {
          pass: true,
          output: '{\n  "MACHINE": "machine"\n}',
        },
      },
    },
    {
      scenario: '104_INLINE_COMMENT',
      env: 'INLINE_COMMENT=inline comment # works #very #well\n',
      expected: '{\n  "INLINE_COMMENT": "inline comment"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "INLINE_COMMENT": "inline comment"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "INLINE_COMMENT": "inline comment # works #very #well"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "INLINE_COMMENT": "inline comment"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "INLINE_COMMENT": "inline comment"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "INLINE_COMMENT": "inline comment"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "INLINE_COMMENT": "inline comment"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "INLINE_COMMENT": "inline comment"\n}',
        },
        phpdotenv: {
          pass: false,
          output: null,
        },
        godotenv: {
          pass: false,
          output: '{\n  "INLINE_COMMENT": "inline comment # works #very"\n}',
        },
      },
    },
    {
      scenario: '105_INLINE_COMMENT_NO_SPACE',
      env: 'INLINE_COMMENT_NO_SPACE=inline comments start with a#number sign. no space required.\n',
      expected: '{\n  "INLINE_COMMENT_NO_SPACE": "inline comments start with a"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "INLINE_COMMENT_NO_SPACE": "inline comments start with a"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "INLINE_COMMENT_NO_SPACE": "inline comments start with a#number sign. no space required."\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "INLINE_COMMENT_NO_SPACE": "inline comments start with a#number sign. no space required."\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "INLINE_COMMENT_NO_SPACE": "inline comments start with a"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "INLINE_COMMENT_NO_SPACE": "inline comments start with a"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "INLINE_COMMENT_NO_SPACE": "inline comments start with a"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "INLINE_COMMENT_NO_SPACE": "inline comments start with a#number sign. no space required."\n}',
        },
        phpdotenv: {
          pass: false,
          output: null,
        },
        godotenv: {
          pass: false,
          output: '{\n  "INLINE_COMMENT_NO_SPACE": "inline comments start with a#number sign. no space required."\n}',
        },
      },
    },
    {
      scenario: '106_AFTER_LINE',
      env: '\n# previous line intentionally left blank\nAFTER_LINE=after_line\n',
      expected: '{\n  "AFTER_LINE": "after_line"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "AFTER_LINE": "after_line"\n}',
        },
        docker: {
          pass: true,
          output: '{\n  "AFTER_LINE": "after_line"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "AFTER_LINE": "after_line"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "AFTER_LINE": "after_line"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "AFTER_LINE": "after_line"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "AFTER_LINE": "after_line"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "AFTER_LINE": "after_line"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "AFTER_LINE": "after_line"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "AFTER_LINE": "after_line"\n}',
        },
      },
    },
    {
      scenario: '107_EXPORT',
      env: '#!/usr/bin/env bash\nexport KEY=value\n',
      expected: '{\n  "KEY": "value"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "KEY": "value"\n}',
        },
        docker: {
          pass: false,
          output: null,
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "KEY": "value"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "KEY": "value"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "KEY": "value"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "KEY": "value"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "KEY": "value"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "KEY": "value"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "KEY": "value"\n}',
        },
      },
    },
    {
      scenario: '108_USERNAME',
      env: 'USERNAME=therealnerdybeast@example.tld\n',
      expected: '{\n  "USERNAME": "therealnerdybeast@example.tld"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "USERNAME": "therealnerdybeast@example.tld"\n}',
        },
        docker: {
          pass: true,
          output: '{\n  "USERNAME": "therealnerdybeast@example.tld"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "USERNAME": "therealnerdybeast@example.tld"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "USERNAME": "therealnerdybeast@example.tld"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "USERNAME": "therealnerdybeast@example.tld"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "USERNAME": "therealnerdybeast@example.tld"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "USERNAME": "therealnerdybeast@example.tld"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "USERNAME": "therealnerdybeast@example.tld"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "USERNAME": "therealnerdybeast@example.tld"\n}',
        },
      },
    },
    {
      scenario: '109_SPACED_KEY',
      env: '    SPACED_KEY = parsed\n',
      expected: '{\n  "SPACED_KEY": "parsed"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "SPACED_KEY": "parsed"\n}',
        },
        docker: {
          pass: false,
          output: null,
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "SPACED_KEY": "parsed"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "SPACED_KEY": "parsed"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "SPACED_KEY": "parsed"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "SPACED_KEY": "parsed"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "SPACED_KEY": "parsed"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "SPACED_KEY": "parsed"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "SPACED_KEY": "parsed"\n}',
        },
      },
    },
    {
      scenario: '110_TRIM_SPACE',
      env: 'TRIM_SPACE=    some spaced out string\n',
      expected: '{\n  "TRIM_SPACE": "some spaced out string"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "TRIM_SPACE": "some spaced out string"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "TRIM_SPACE": "    some spaced out string"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "TRIM_SPACE": "some spaced out string"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "TRIM_SPACE": "some spaced out string"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "TRIM_SPACE": "some spaced out string"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "TRIM_SPACE": "some spaced out string"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "TRIM_SPACE": "some spaced out string"\n}',
        },
        phpdotenv: {
          pass: false,
          output: null,
        },
        godotenv: {
          pass: true,
          output: '{\n  "TRIM_SPACE": "some spaced out string"\n}',
        },
      },
    },
    {
      scenario: '111_EQUAL_SIGNS',
      env: 'EQUAL_SIGNS=equals==\n',
      expected: '{\n  "EQUAL_SIGNS": "equals=="\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EQUAL_SIGNS": "equals=="\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EQUAL_SIGNS": "equals"\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "EQUAL_SIGNS": "equals"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EQUAL_SIGNS": "equals=="\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "EQUAL_SIGNS": "equals=="\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "EQUAL_SIGNS": "equals=="\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "EQUAL_SIGNS": "equals=="\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "EQUAL_SIGNS": "equals=="\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "EQUAL_SIGNS": "equals=="\n}',
        },
      },
    },
    {
      scenario: '112_DONT_EXPAND_NEWLINES',
      env: 'DONT_EXPAND=dontexpand\\nnewlines\n',
      expected: '{\n  "DONT_EXPAND": "dontexpand\\\\nnewlines"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "DONT_EXPAND": "dontexpand\\\\nnewlines"\n}',
        },
        docker: {
          pass: true,
          output: '{\n  "DONT_EXPAND": "dontexpand\\\\nnewlines"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "DONT_EXPAND": "dontexpand\\\\nnewlines"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "DONT_EXPAND": "dontexpand\\\\nnewlines"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "DONT_EXPAND": "dontexpand\\\\nnewlines"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "DONT_EXPAND": "dontexpandnnewlines"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "DONT_EXPAND": "dontexpand\\\\nnewlines"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "DONT_EXPAND": "dontexpand\\\\nnewlines"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "DONT_EXPAND": "dontexpand\\\\nnewlines"\n}',
        },
      },
    },
    {
      scenario: '113_HY-PHEN',
      env: '# https://github.com/joho/godotenv/pull/245\nHY-PHEN=hyphen\n',
      expected: '{\n  "HY-PHEN": "hyphen"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "HY-PHEN": "hyphen"\n}',
        },
        docker: {
          pass: true,
          output: '{\n  "HY-PHEN": "hyphen"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "HY-PHEN": "hyphen"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "HY-PHEN": "hyphen"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "HY-PHEN": "hyphen"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "HY-PHEN": "hyphen"\n}',
        },
        phpdotenv: {
          pass: false,
          output: null,
        },
        godotenv: {
          pass: false,
          output: null,
        },
      },
    },
    {
      scenario: '114_RETAIN_INNER_QUOTES',
      env: 'RETAIN_INNER_QUOTES={"foo": "bar"}\n',
      expected: '{\n  "RETAIN_INNER_QUOTES": "{\\"foo\\": \\"bar\\"}"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "RETAIN_INNER_QUOTES": "{\\"foo\\": \\"bar\\"}"\n}',
        },
        docker: {
          pass: true,
          output: '{\n  "RETAIN_INNER_QUOTES": "{\\"foo\\": \\"bar\\"}"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "RETAIN_INNER_QUOTES": "{\\"foo\\": \\"bar\\"}"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "RETAIN_INNER_QUOTES": "{\\"foo\\": \\"bar\\"}"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "RETAIN_INNER_QUOTES": "{\\"foo\\": \\"bar\\"}"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "RETAIN_INNER_QUOTES": "{\\"foo\\": \\"bar\\"}"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "RETAIN_INNER_QUOTES": "{\\"foo\\": \\"bar\\"}"\n}',
        },
        phpdotenv: {
          pass: false,
          output: null,
        },
        godotenv: {
          pass: true,
          output: '{\n  "RETAIN_INNER_QUOTES": "{\\"foo\\": \\"bar\\"}"\n}',
        },
      },
    },
    {
      scenario: '115_DOLLAR',
      env: 'DOLLAR=$\n',
      expected: '{\n  "DOLLAR": "$"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "DOLLAR": "$"\n}',
        },
        docker: {
          pass: true,
          output: '{\n  "DOLLAR": "$"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "DOLLAR": "$"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "DOLLAR": "$"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "DOLLAR": "$"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "DOLLAR": "$"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "DOLLAR": "$"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "DOLLAR": "$"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "DOLLAR": "$"\n}',
        },
      },
    },
    {
      scenario: '116_DOTS',
      env: 'POSTGRESQL.BASE.USER=postgres\n',
      expected: '{\n  "POSTGRESQL.BASE.USER": "postgres"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "POSTGRESQL.BASE.USER": "postgres"\n}',
        },
        docker: {
          pass: true,
          output: '{\n  "POSTGRESQL.BASE.USER": "postgres"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "POSTGRESQL.BASE.USER": "postgres"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "POSTGRESQL.BASE.USER": "postgres"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "POSTGRESQL.BASE.USER": "postgres"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "POSTGRESQL.BASE.USER": "postgres"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "POSTGRESQL.BASE.USER": "postgres"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "POSTGRESQL.BASE.USER": "postgres"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "POSTGRESQL.BASE.USER": "postgres"\n}',
        },
      },
    },
    {
      scenario: '117_DONT_CHOKE',
      env: "DONT_CHOKE1='.kZh`>4[,[DDU-*Jt+[;8-,@K=,9%;F9KsoXqOE)gpG^X!{)Q+/9Fc(QF}i[NEi!'\nDONT_CHOKE2='=;+=CNy3)-D=zI6gRP2w\\$B@0K;Y]e^EFnCmx\\$Dx?;.9wf-rgk1BcTR0]JtY<S:b_'\nDONT_CHOKE3='MUcKSGSY@HCON<1S_siWTP`DgS*Ug],mu]SkqI|7V2eOk9:>&fw;>HEwms`D8E2H'\nDONT_CHOKE4='m]zjzfRItw2gs[2:{p{ugENyFw9m)tH6_VCQzer`*noVaI<vqa3?FZ9+6U;K#Bfd'\nDONT_CHOKE5='#la__nK?IxNlQ%`5q&DpcZ>Munx=[1-AMgAcwmPkToxTaB?kgdF5y`A8m=Oa-B!)'\nDONT_CHOKE6='xlC&*<j4J<d._<JKH0RBJV!4(ZQEN-+&!0p137<g*hdY2H4xk?/;KO1\\$(W{:Wc}Q'\nDONT_CHOKE7='?\\$6)m*xhTVewc#NVVgxX%eBhJjoHYzpXFg=gzn[rWXPLj5UWj@z\\$/UDm8o79n/p%'\nDONT_CHOKE8='@}:[4#g%[R-CFR});bY(Z[KcDQDsVn2_y4cSdU<Mjy!c^F`G<!Ks7]kbS]N1:bP:'\n",
      expected: '{\n  "DONT_CHOKE1": ".kZh`>4[,[DDU-*Jt+[;8-,@K=,9%;F9KsoXqOE)gpG^X!{)Q+/9Fc(QF}i[NEi!",\n  "DONT_CHOKE2": "=;+=CNy3)-D=zI6gRP2w\\\\$B@0K;Y]e^EFnCmx\\\\$Dx?;.9wf-rgk1BcTR0]JtY<S:b_",\n  "DONT_CHOKE3": "MUcKSGSY@HCON<1S_siWTP`DgS*Ug],mu]SkqI|7V2eOk9:>&fw;>HEwms`D8E2H",\n  "DONT_CHOKE4": "m]zjzfRItw2gs[2:{p{ugENyFw9m)tH6_VCQzer`*noVaI<vqa3?FZ9+6U;K#Bfd",\n  "DONT_CHOKE5": "#la__nK?IxNlQ%`5q&DpcZ>Munx=[1-AMgAcwmPkToxTaB?kgdF5y`A8m=Oa-B!)",\n  "DONT_CHOKE6": "xlC&*<j4J<d._<JKH0RBJV!4(ZQEN-+&!0p137<g*hdY2H4xk?/;KO1\\\\$(W{:Wc}Q",\n  "DONT_CHOKE7": "?\\\\$6)m*xhTVewc#NVVgxX%eBhJjoHYzpXFg=gzn[rWXPLj5UWj@z\\\\$/UDm8o79n/p%",\n  "DONT_CHOKE8": "@}:[4#g%[R-CFR});bY(Z[KcDQDsVn2_y4cSdU<Mjy!c^F`G<!Ks7]kbS]N1:bP:"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "DONT_CHOKE1": ".kZh`>4[,[DDU-*Jt+[;8-,@K=,9%;F9KsoXqOE)gpG^X!{)Q+/9Fc(QF}i[NEi!",\n  "DONT_CHOKE2": "=;+=CNy3)-D=zI6gRP2w\\\\$B@0K;Y]e^EFnCmx\\\\$Dx?;.9wf-rgk1BcTR0]JtY<S:b_",\n  "DONT_CHOKE3": "MUcKSGSY@HCON<1S_siWTP`DgS*Ug],mu]SkqI|7V2eOk9:>&fw;>HEwms`D8E2H",\n  "DONT_CHOKE4": "m]zjzfRItw2gs[2:{p{ugENyFw9m)tH6_VCQzer`*noVaI<vqa3?FZ9+6U;K#Bfd",\n  "DONT_CHOKE5": "#la__nK?IxNlQ%`5q&DpcZ>Munx=[1-AMgAcwmPkToxTaB?kgdF5y`A8m=Oa-B!)",\n  "DONT_CHOKE6": "xlC&*<j4J<d._<JKH0RBJV!4(ZQEN-+&!0p137<g*hdY2H4xk?/;KO1\\\\$(W{:Wc}Q",\n  "DONT_CHOKE7": "?\\\\$6)m*xhTVewc#NVVgxX%eBhJjoHYzpXFg=gzn[rWXPLj5UWj@z\\\\$/UDm8o79n/p%",\n  "DONT_CHOKE8": "@}:[4#g%[R-CFR});bY(Z[KcDQDsVn2_y4cSdU<Mjy!c^F`G<!Ks7]kbS]N1:bP:"\n}',
        },
        docker: {
          pass: false,
          output: "{\n  \"DONT_CHOKE1\": \"'.kZh`>4[,[DDU-*Jt+[;8-,@K\",\n  \"DONT_CHOKE2\": \"'\",\n  \"DONT_CHOKE3\": \"'MUcKSGSY@HCON<1S_siWTP`DgS*Ug],mu]SkqI|7V2eOk9:>&fw;>HEwms`D8E2H'\",\n  \"DONT_CHOKE4\": \"'m]zjzfRItw2gs[2:{p{ugENyFw9m)tH6_VCQzer`*noVaI<vqa3?FZ9+6U;K#Bfd'\",\n  \"DONT_CHOKE5\": \"'#la__nK?IxNlQ%`5q&DpcZ>Munx\",\n  \"DONT_CHOKE6\": \"'xlC&*<j4J<d._<JKH0RBJV!4(ZQEN-+&!0p137<g*hdY2H4xk?/;KO1\\\\$(W{:Wc}Q'\",\n  \"DONT_CHOKE7\": \"'?\\\\$6)m*xhTVewc#NVVgxX%eBhJjoHYzpXFg\",\n  \"DONT_CHOKE8\": \"'@}:[4#g%[R-CFR});bY(Z[KcDQDsVn2_y4cSdU<Mjy!c^F`G<!Ks7]kbS]N1:bP:'\"\n}",
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "DONT_CHOKE1": ".kZh`>4[,[DDU-*Jt+[;8-,@K",\n  "DONT_CHOKE2": "",\n  "DONT_CHOKE3": "MUcKSGSY@HCON<1S_siWTP`DgS*Ug],mu]SkqI|7V2eOk9:>&fw;>HEwms`D8E2H",\n  "DONT_CHOKE4": "m]zjzfRItw2gs[2:{p{ugENyFw9m)tH6_VCQzer`*noVaI<vqa3?FZ9+6U;K#Bfd",\n  "DONT_CHOKE5": "#la__nK?IxNlQ%`5q&DpcZ>Munx",\n  "DONT_CHOKE6": "xlC&*<j4J<d._<JKH0RBJV!4(ZQEN-+&!0p137<g*hdY2H4xk?/;KO1\\\\$(W{:Wc}Q",\n  "DONT_CHOKE7": "?\\\\$6)m*xhTVewc#NVVgxX%eBhJjoHYzpXFg",\n  "DONT_CHOKE8": "@}:[4#g%[R-CFR});bY(Z[KcDQDsVn2_y4cSdU<Mjy!c^F`G<!Ks7]kbS]N1:bP:"\n}',
        },
        'npm@dotenv': {
          pass: false,
          output: '{\n  "DONT_CHOKE1": ".kZh`>4[,[DDU-*Jt+[;8-,@K=,9%;F9KsoXqOE)gpG^X!{)Q+/9Fc(QF}i[NEi!",\n  "DONT_CHOKE2": "=;+=CNy3)-D=zI6gRP2w$B@0K;Y]e^EFnCmx$Dx?;.9wf-rgk1BcTR0]JtY<S:b_",\n  "DONT_CHOKE3": "MUcKSGSY@HCON<1S_siWTP`DgS*Ug],mu]SkqI|7V2eOk9:>&fw;>HEwms`D8E2H",\n  "DONT_CHOKE4": "m]zjzfRItw2gs[2:{p{ugENyFw9m)tH6_VCQzer`*noVaI<vqa3?FZ9+6U;K#Bfd",\n  "DONT_CHOKE5": "#la__nK?IxNlQ%`5q&DpcZ>Munx=[1-AMgAcwmPkToxTaB?kgdF5y`A8m=Oa-B!)",\n  "DONT_CHOKE6": "xlC&*<j4J<d._<JKH0RBJV!4(ZQEN-+&!0p137<g*hdY2H4xk?/;KO1$(W{:Wc}Q",\n  "DONT_CHOKE7": "?$6)m*xhTVewc#NVVgxX%eBhJjoHYzpXFg=gzn[rWXPLj5UWj@z$/UDm8o79n/p%",\n  "DONT_CHOKE8": "@}:[4#g%[R-CFR});bY(Z[KcDQDsVn2_y4cSdU<Mjy!c^F`G<!Ks7]kbS]N1:bP:"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "DONT_CHOKE1": ".kZh`>4[,[DDU-*Jt+[;8-,@K=,9%;F9KsoXqOE)gpG^X!{)Q+/9Fc(QF}i[NEi!",\n  "DONT_CHOKE2": "=;+=CNy3)-D=zI6gRP2w$B@0K;Y]e^EFnCmx$Dx?;.9wf-rgk1BcTR0]JtY<S:b_",\n  "DONT_CHOKE3": "MUcKSGSY@HCON<1S_siWTP`DgS*Ug],mu]SkqI|7V2eOk9:>&fw;>HEwms`D8E2H",\n  "DONT_CHOKE4": "m]zjzfRItw2gs[2:{p{ugENyFw9m)tH6_VCQzer`*noVaI<vqa3?FZ9+6U;K#Bfd",\n  "DONT_CHOKE5": "#la__nK?IxNlQ%`5q&DpcZ>Munx=[1-AMgAcwmPkToxTaB?kgdF5y`A8m=Oa-B!)",\n  "DONT_CHOKE6": "xlC&*<j4J<d._<JKH0RBJV!4(ZQEN-+&!0p137<g*hdY2H4xk?/;KO1$(W{:Wc}Q",\n  "DONT_CHOKE7": "?$6)m*xhTVewc#NVVgxX%eBhJjoHYzpXFg=gzn[rWXPLj5UWj@z$/UDm8o79n/p%",\n  "DONT_CHOKE8": "@}:[4#g%[R-CFR});bY(Z[KcDQDsVn2_y4cSdU<Mjy!c^F`G<!Ks7]kbS]N1:bP:"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "DONT_CHOKE1": ".kZh`>4[,[DDU-*Jt+[;8-,@K=,9%;F9KsoXqOE)gpG^X!{)Q+/9Fc(QF}i[NEi!",\n  "DONT_CHOKE2": "=;+=CNy3)-D=zI6gRP2w\\\\$B@0K;Y]e^EFnCmx\\\\$Dx?;.9wf-rgk1BcTR0]JtY<S:b_",\n  "DONT_CHOKE3": "MUcKSGSY@HCON<1S_siWTP`DgS*Ug],mu]SkqI|7V2eOk9:>&fw;>HEwms`D8E2H",\n  "DONT_CHOKE4": "m]zjzfRItw2gs[2:{p{ugENyFw9m)tH6_VCQzer`*noVaI<vqa3?FZ9+6U;K#Bfd",\n  "DONT_CHOKE5": "#la__nK?IxNlQ%`5q&DpcZ>Munx=[1-AMgAcwmPkToxTaB?kgdF5y`A8m=Oa-B!)",\n  "DONT_CHOKE6": "xlC&*<j4J<d._<JKH0RBJV!4(ZQEN-+&!0p137<g*hdY2H4xk?/;KO1\\\\$(W{:Wc}Q",\n  "DONT_CHOKE7": "?\\\\$6)m*xhTVewc#NVVgxX%eBhJjoHYzpXFg=gzn[rWXPLj5UWj@z\\\\$/UDm8o79n/p%",\n  "DONT_CHOKE8": "@}:[4#g%[R-CFR});bY(Z[KcDQDsVn2_y4cSdU<Mjy!c^F`G<!Ks7]kbS]N1:bP:"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "DONT_CHOKE1": ".kZh`>4[,[DDU-*Jt+[;8-,@K=,9%;F9KsoXqOE)gpG^X!{)Q+/9Fc(QF}i[NEi!",\n  "DONT_CHOKE2": "=;+=CNy3)-D=zI6gRP2w\\\\$B@0K;Y]e^EFnCmx\\\\$Dx?;.9wf-rgk1BcTR0]JtY<S:b_",\n  "DONT_CHOKE3": "MUcKSGSY@HCON<1S_siWTP`DgS*Ug],mu]SkqI|7V2eOk9:>&fw;>HEwms`D8E2H",\n  "DONT_CHOKE4": "m]zjzfRItw2gs[2:{p{ugENyFw9m)tH6_VCQzer`*noVaI<vqa3?FZ9+6U;K#Bfd",\n  "DONT_CHOKE5": "#la__nK?IxNlQ%`5q&DpcZ>Munx=[1-AMgAcwmPkToxTaB?kgdF5y`A8m=Oa-B!)",\n  "DONT_CHOKE6": "xlC&*<j4J<d._<JKH0RBJV!4(ZQEN-+&!0p137<g*hdY2H4xk?/;KO1\\\\$(W{:Wc}Q",\n  "DONT_CHOKE7": "?\\\\$6)m*xhTVewc#NVVgxX%eBhJjoHYzpXFg=gzn[rWXPLj5UWj@z\\\\$/UDm8o79n/p%",\n  "DONT_CHOKE8": "@}:[4#g%[R-CFR});bY(Z[KcDQDsVn2_y4cSdU<Mjy!c^F`G<!Ks7]kbS]N1:bP:"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "DONT_CHOKE1": ".kZh`>4[,[DDU-*Jt+[;8-,@K=,9%;F9KsoXqOE)gpG^X!{)Q+/9Fc(QF}i[NEi!",\n  "DONT_CHOKE2": "=;+=CNy3)-D=zI6gRP2w\\\\$B@0K;Y]e^EFnCmx\\\\$Dx?;.9wf-rgk1BcTR0]JtY<S:b_",\n  "DONT_CHOKE3": "MUcKSGSY@HCON<1S_siWTP`DgS*Ug],mu]SkqI|7V2eOk9:>&fw;>HEwms`D8E2H",\n  "DONT_CHOKE4": "m]zjzfRItw2gs[2:{p{ugENyFw9m)tH6_VCQzer`*noVaI<vqa3?FZ9+6U;K#Bfd",\n  "DONT_CHOKE5": "#la__nK?IxNlQ%`5q&DpcZ>Munx=[1-AMgAcwmPkToxTaB?kgdF5y`A8m=Oa-B!)",\n  "DONT_CHOKE6": "xlC&*<j4J<d._<JKH0RBJV!4(ZQEN-+&!0p137<g*hdY2H4xk?/;KO1\\\\$(W{:Wc}Q",\n  "DONT_CHOKE7": "?\\\\$6)m*xhTVewc#NVVgxX%eBhJjoHYzpXFg=gzn[rWXPLj5UWj@z\\\\$/UDm8o79n/p%",\n  "DONT_CHOKE8": "@}:[4#g%[R-CFR});bY(Z[KcDQDsVn2_y4cSdU<Mjy!c^F`G<!Ks7]kbS]N1:bP:"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "DONT_CHOKE1": ".kZh`>4[,[DDU-*Jt+[;8-,@K=,9%;F9KsoXqOE)gpG^X!{)Q+/9Fc(QF}i[NEi!",\n  "DONT_CHOKE2": "=;+=CNy3)-D=zI6gRP2w\\\\$B@0K;Y]e^EFnCmx\\\\$Dx?;.9wf-rgk1BcTR0]JtY<S:b_",\n  "DONT_CHOKE3": "MUcKSGSY@HCON<1S_siWTP`DgS*Ug],mu]SkqI|7V2eOk9:>&fw;>HEwms`D8E2H",\n  "DONT_CHOKE4": "m]zjzfRItw2gs[2:{p{ugENyFw9m)tH6_VCQzer`*noVaI<vqa3?FZ9+6U;K#Bfd",\n  "DONT_CHOKE5": "#la__nK?IxNlQ%`5q&DpcZ>Munx=[1-AMgAcwmPkToxTaB?kgdF5y`A8m=Oa-B!)",\n  "DONT_CHOKE6": "xlC&*<j4J<d._<JKH0RBJV!4(ZQEN-+&!0p137<g*hdY2H4xk?/;KO1\\\\$(W{:Wc}Q",\n  "DONT_CHOKE7": "?\\\\$6)m*xhTVewc#NVVgxX%eBhJjoHYzpXFg=gzn[rWXPLj5UWj@z\\\\$/UDm8o79n/p%",\n  "DONT_CHOKE8": "@}:[4#g%[R-CFR});bY(Z[KcDQDsVn2_y4cSdU<Mjy!c^F`G<!Ks7]kbS]N1:bP:"\n}',
        },
      },
    },
    {
      scenario: '201_SINGLE_QUOTES',
      env: "SINGLE_QUOTES='single_quotes'\n",
      expected: '{\n  "SINGLE_QUOTES": "single_quotes"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "SINGLE_QUOTES": "single_quotes"\n}',
        },
        docker: {
          pass: false,
          output: "{\n  \"SINGLE_QUOTES\": \"'single_quotes'\"\n}",
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "SINGLE_QUOTES": "single_quotes"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "SINGLE_QUOTES": "single_quotes"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "SINGLE_QUOTES": "single_quotes"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "SINGLE_QUOTES": "single_quotes"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "SINGLE_QUOTES": "single_quotes"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "SINGLE_QUOTES": "single_quotes"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "SINGLE_QUOTES": "single_quotes"\n}',
        },
      },
    },
    {
      scenario: '202_SINGLE_QUOTES_EMPTY',
      env: "EMPTY=''\n",
      expected: '{\n  "EMPTY": ""\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        docker: {
          pass: false,
          output: "{\n  \"EMPTY\": \"''\"\n}",
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
      },
    },
    {
      scenario: '203_SINGLE_QUOTES_SPACED',
      env: "SINGLE_QUOTES_SPACED='    single quotes    '\n",
      expected: '{\n  "SINGLE_QUOTES_SPACED": "    single quotes    "\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "SINGLE_QUOTES_SPACED": "    single quotes    "\n}',
        },
        docker: {
          pass: false,
          output: "{\n  \"SINGLE_QUOTES_SPACED\": \"'    single quotes    '\"\n}",
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "SINGLE_QUOTES_SPACED": "    single quotes    "\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "SINGLE_QUOTES_SPACED": "    single quotes    "\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "SINGLE_QUOTES_SPACED": "    single quotes    "\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "SINGLE_QUOTES_SPACED": "    single quotes    "\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "SINGLE_QUOTES_SPACED": "    single quotes    "\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "SINGLE_QUOTES_SPACED": "    single quotes    "\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "SINGLE_QUOTES_SPACED": "    single quotes    "\n}',
        },
      },
    },
    {
      scenario: '204_SINGLE_QUOTES_DONT_EXPAND_NEWLINES',
      env: "DONT_EXPAND='dontexpand\\nnewlines'\n",
      expected: '{\n  "DONT_EXPAND": "dontexpand\\\\nnewlines"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "DONT_EXPAND": "dontexpand\\\\nnewlines"\n}',
        },
        docker: {
          pass: false,
          output: "{\n  \"DONT_EXPAND\": \"'dontexpand\\\\nnewlines'\"\n}",
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "DONT_EXPAND": "dontexpand\\\\nnewlines"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "DONT_EXPAND": "dontexpand\\\\nnewlines"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "DONT_EXPAND": "dontexpand\\\\nnewlines"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "DONT_EXPAND": "dontexpand\\\\nnewlines"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "DONT_EXPAND": "dontexpand\\\\nnewlines"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "DONT_EXPAND": "dontexpand\\\\nnewlines"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "DONT_EXPAND": "dontexpand\\\\nnewlines"\n}',
        },
      },
    },
    {
      scenario: '205_SINGLE_QUOTES_INLINE_COMMENT',
      env: "INLINE_COMMENT='inline comments outside of #singlequotes' # work\n",
      expected: '{\n  "INLINE_COMMENT": "inline comments outside of #singlequotes"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "INLINE_COMMENT": "inline comments outside of #singlequotes"\n}',
        },
        docker: {
          pass: false,
          output: "{\n  \"INLINE_COMMENT\": \"'inline comments outside of #singlequotes' # work\"\n}",
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "INLINE_COMMENT": "inline comments outside of #singlequotes"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "INLINE_COMMENT": "inline comments outside of #singlequotes"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "INLINE_COMMENT": "inline comments outside of #singlequotes"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "INLINE_COMMENT": "inline comments outside of #singlequotes"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "INLINE_COMMENT": "inline comments outside of #singlequotes"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "INLINE_COMMENT": "inline comments outside of #singlequotes"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "INLINE_COMMENT": "inline comments outside of #singlequotes"\n}',
        },
      },
    },
    {
      scenario: '206_SINGLE_QUOTES_MULTILINE',
      env: "MULTILINE='one\ntwo\nthree'\n",
      expected: '{\n  "MULTILINE": "one\\ntwo\\nthree"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "MULTILINE": "one\\ntwo\\nthree"\n}',
        },
        docker: {
          pass: false,
          output: "{\n  \"MULTILINE\": \"'one\"\n}",
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "MULTILINE": "one"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "MULTILINE": "one\\ntwo\\nthree"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "MULTILINE": "one\\ntwo\\nthree"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "MULTILINE": "one\\ntwo\\nthree"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "MULTILINE": "one\\ntwo\\nthree"\n}',
        },
        phpdotenv: {
          pass: false,
          output: null,
        },
        godotenv: {
          pass: true,
          output: '{\n  "MULTILINE": "one\\ntwo\\nthree"\n}',
        },
      },
    },
    {
      scenario: '207_SINGLE_QUOTES_RETAIN_INNER_QUOTES',
      env: "RETAIN_INNER_QUOTES_AS_STRING='{\"foo\": \"bar\"}'\n",
      expected: '{\n  "RETAIN_INNER_QUOTES_AS_STRING": "{\\"foo\\": \\"bar\\"}"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "RETAIN_INNER_QUOTES_AS_STRING": "{\\"foo\\": \\"bar\\"}"\n}',
        },
        docker: {
          pass: false,
          output: "{\n  \"RETAIN_INNER_QUOTES_AS_STRING\": \"'{\\\"foo\\\": \\\"bar\\\"}'\"\n}",
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "RETAIN_INNER_QUOTES_AS_STRING": "{\\"foo\\": \\"bar\\"}"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "RETAIN_INNER_QUOTES_AS_STRING": "{\\"foo\\": \\"bar\\"}"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "RETAIN_INNER_QUOTES_AS_STRING": "{\\"foo\\": \\"bar\\"}"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "RETAIN_INNER_QUOTES_AS_STRING": "{\\"foo\\": \\"bar\\"}"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "RETAIN_INNER_QUOTES_AS_STRING": "{\\"foo\\": \\"bar\\"}"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "RETAIN_INNER_QUOTES_AS_STRING": "{\\"foo\\": \\"bar\\"}"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "RETAIN_INNER_QUOTES_AS_STRING": "{\\"foo\\": \\"bar\\"}"\n}',
        },
      },
    },
    {
      scenario: '208_SINGLE_QUOTES_WITH_DOUBLE_QUOTES_INSIDE',
      env: "DOUBLE_QUOTES_INSIDE_SINGLE='double \"quotes\" work inside single quotes'\n",
      expected: '{\n  "DOUBLE_QUOTES_INSIDE_SINGLE": "double \\"quotes\\" work inside single quotes"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_INSIDE_SINGLE": "double \\"quotes\\" work inside single quotes"\n}',
        },
        docker: {
          pass: false,
          output: "{\n  \"DOUBLE_QUOTES_INSIDE_SINGLE\": \"'double \\\"quotes\\\" work inside single quotes'\"\n}",
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_INSIDE_SINGLE": "double \\"quotes\\" work inside single quotes"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_INSIDE_SINGLE": "double \\"quotes\\" work inside single quotes"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_INSIDE_SINGLE": "double \\"quotes\\" work inside single quotes"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_INSIDE_SINGLE": "double \\"quotes\\" work inside single quotes"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_INSIDE_SINGLE": "double \\"quotes\\" work inside single quotes"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_INSIDE_SINGLE": "double \\"quotes\\" work inside single quotes"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_INSIDE_SINGLE": "double \\"quotes\\" work inside single quotes"\n}',
        },
      },
    },
    {
      scenario: '209_SINGLE_QUOTES_WITH_BACKTICKS_INSIDE',
      env: "BACKTICKS_INSIDE_SINGLE='`backticks` work inside single quotes'\n",
      expected: '{\n  "BACKTICKS_INSIDE_SINGLE": "`backticks` work inside single quotes"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "BACKTICKS_INSIDE_SINGLE": "`backticks` work inside single quotes"\n}',
        },
        docker: {
          pass: false,
          output: "{\n  \"BACKTICKS_INSIDE_SINGLE\": \"'`backticks` work inside single quotes'\"\n}",
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "BACKTICKS_INSIDE_SINGLE": "`backticks` work inside single quotes"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "BACKTICKS_INSIDE_SINGLE": "`backticks` work inside single quotes"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "BACKTICKS_INSIDE_SINGLE": "`backticks` work inside single quotes"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "BACKTICKS_INSIDE_SINGLE": "`backticks` work inside single quotes"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "BACKTICKS_INSIDE_SINGLE": "`backticks` work inside single quotes"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "BACKTICKS_INSIDE_SINGLE": "`backticks` work inside single quotes"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "BACKTICKS_INSIDE_SINGLE": "`backticks` work inside single quotes"\n}',
        },
      },
    },
    {
      scenario: '210_SINGLE_QUOTES_PARENTHESES',
      env: "# https://github.com/bkeepers/dotenv/pull/526\nPARENTHESES='passwo(rd'\n",
      expected: '{\n  "PARENTHESES": "passwo(rd"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "PARENTHESES": "passwo(rd"\n}',
        },
        docker: {
          pass: false,
          output: "{\n  \"PARENTHESES\": \"'passwo(rd'\"\n}",
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "PARENTHESES": "passwo(rd"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "PARENTHESES": "passwo(rd"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "PARENTHESES": "passwo(rd"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "PARENTHESES": "passwo(rd"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "PARENTHESES": "passwo(rd"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "PARENTHESES": "passwo(rd"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "PARENTHESES": "passwo(rd"\n}',
        },
      },
    },
    {
      scenario: '301_DOUBLE_QUOTES',
      env: 'DOUBLE_QUOTES="double_quotes"\n',
      expected: '{\n  "DOUBLE_QUOTES": "double_quotes"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES": "double_quotes"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "DOUBLE_QUOTES": "\\"double_quotes\\""\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES": "double_quotes"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES": "double_quotes"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES": "double_quotes"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES": "double_quotes"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES": "double_quotes"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES": "double_quotes"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES": "double_quotes"\n}',
        },
      },
    },
    {
      scenario: '302_DOUBLE_QUOTES_EMPTY',
      env: 'EMPTY=""\n',
      expected: '{\n  "EMPTY": ""\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EMPTY": "\\"\\""\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
      },
    },
    {
      scenario: '303_DOUBLE_QUOTES_SPACED',
      env: 'DOUBLE_QUOTES_SPACED="    double quotes    "\n',
      expected: '{\n  "DOUBLE_QUOTES_SPACED": "    double quotes    "\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_SPACED": "    double quotes    "\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "DOUBLE_QUOTES_SPACED": "\\"    double quotes    \\""\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_SPACED": "    double quotes    "\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_SPACED": "    double quotes    "\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_SPACED": "    double quotes    "\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_SPACED": "    double quotes    "\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_SPACED": "    double quotes    "\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_SPACED": "    double quotes    "\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_SPACED": "    double quotes    "\n}',
        },
      },
    },
    {
      scenario: '304_DOUBLE_QUOTES_EXPAND_NEWLINES',
      env: 'EXPAND_NEWLINES="expand\\nnew\\nlines"\n',
      expected: '{\n  "EXPAND_NEWLINES": "expand\\nnew\\nlines"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_NEWLINES": "expand\\nnew\\nlines"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_NEWLINES": "\\"expand\\\\nnew\\\\nlines\\""\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "EXPAND_NEWLINES": "expand"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_NEWLINES": "expand\\nnew\\nlines"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "EXPAND_NEWLINES": "expand\\nnew\\nlines"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_NEWLINES": "expand\\\\nnew\\\\nlines"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "EXPAND_NEWLINES": "expand\\nnew\\nlines"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "EXPAND_NEWLINES": "expand\\nnew\\nlines"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "EXPAND_NEWLINES": "expand\\nnew\\nlines"\n}',
        },
      },
    },
    {
      scenario: '305_DOUBLE_QUOTES_INLINE_COMMENT',
      env: 'INLINE_COMMENTS_DOUBLE_QUOTES="inline comments outside of #doublequotes" # work\n',
      expected: '{\n  "INLINE_COMMENTS_DOUBLE_QUOTES": "inline comments outside of #doublequotes"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "INLINE_COMMENTS_DOUBLE_QUOTES": "inline comments outside of #doublequotes"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "INLINE_COMMENTS_DOUBLE_QUOTES": "\\"inline comments outside of #doublequotes\\" # work"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "INLINE_COMMENTS_DOUBLE_QUOTES": "inline comments outside of #doublequotes"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "INLINE_COMMENTS_DOUBLE_QUOTES": "inline comments outside of #doublequotes"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "INLINE_COMMENTS_DOUBLE_QUOTES": "inline comments outside of #doublequotes"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "INLINE_COMMENTS_DOUBLE_QUOTES": "inline comments outside of #doublequotes"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "INLINE_COMMENTS_DOUBLE_QUOTES": "inline comments outside of #doublequotes"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "INLINE_COMMENTS_DOUBLE_QUOTES": "inline comments outside of #doublequotes"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "INLINE_COMMENTS_DOUBLE_QUOTES": "inline comments outside of #doublequotes"\n}',
        },
      },
    },
    {
      scenario: '306_DOUBLE_QUOTES_MULTILINE',
      env: 'MULTILINE="one\ntwo\nthree"\n',
      expected: '{\n  "MULTILINE": "one\\ntwo\\nthree"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "MULTILINE": "one\\ntwo\\nthree"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "MULTILINE": "\\"one"\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "MULTILINE": "one"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "MULTILINE": "one\\ntwo\\nthree"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "MULTILINE": "one\\ntwo\\nthree"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "MULTILINE": "one\\ntwo\\nthree"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "MULTILINE": "one\\ntwo\\nthree"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "MULTILINE": "one\\ntwo\\nthree"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "MULTILINE": "one\\ntwo\\nthree"\n}',
        },
      },
    },
    {
      scenario: '307_DOUBLE_QUOTES_MULTILINE_PEM',
      env: 'MULTILINE_PEM_DOUBLE="-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnNl1tL3QjKp3DZWM0T3u\nLgGJQwu9WqyzHKZ6WIA5T+7zPjO1L8l3S8k8YzBrfH4mqWOD1GBI8Yjq2L1ac3Y/\nbTdfHN8CmQr2iDJC0C6zY8YV93oZB3x0zC/LPbRYpF8f6OqX1lZj5vo2zJZy4fI/\nkKcI5jHYc8VJq+KCuRZrvn+3V+KuL9tF9v8ZgjF2PZbU+LsCy5Yqg1M8f5Jp5f6V\nu4QuUoobAgMBAAE=\n-----END PUBLIC KEY-----"\n',
      expected: '{\n  "MULTILINE_PEM_DOUBLE": "-----BEGIN PUBLIC KEY-----\\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnNl1tL3QjKp3DZWM0T3u\\nLgGJQwu9WqyzHKZ6WIA5T+7zPjO1L8l3S8k8YzBrfH4mqWOD1GBI8Yjq2L1ac3Y/\\nbTdfHN8CmQr2iDJC0C6zY8YV93oZB3x0zC/LPbRYpF8f6OqX1lZj5vo2zJZy4fI/\\nkKcI5jHYc8VJq+KCuRZrvn+3V+KuL9tF9v8ZgjF2PZbU+LsCy5Yqg1M8f5Jp5f6V\\nu4QuUoobAgMBAAE=\\n-----END PUBLIC KEY-----"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "MULTILINE_PEM_DOUBLE": "-----BEGIN PUBLIC KEY-----\\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnNl1tL3QjKp3DZWM0T3u\\nLgGJQwu9WqyzHKZ6WIA5T+7zPjO1L8l3S8k8YzBrfH4mqWOD1GBI8Yjq2L1ac3Y/\\nbTdfHN8CmQr2iDJC0C6zY8YV93oZB3x0zC/LPbRYpF8f6OqX1lZj5vo2zJZy4fI/\\nkKcI5jHYc8VJq+KCuRZrvn+3V+KuL9tF9v8ZgjF2PZbU+LsCy5Yqg1M8f5Jp5f6V\\nu4QuUoobAgMBAAE=\\n-----END PUBLIC KEY-----"\n}',
        },
        docker: {
          pass: false,
          output: null,
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "MULTILINE_PEM_DOUBLE": "-----BEGIN PUBLIC KEY-----"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "MULTILINE_PEM_DOUBLE": "-----BEGIN PUBLIC KEY-----\\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnNl1tL3QjKp3DZWM0T3u\\nLgGJQwu9WqyzHKZ6WIA5T+7zPjO1L8l3S8k8YzBrfH4mqWOD1GBI8Yjq2L1ac3Y/\\nbTdfHN8CmQr2iDJC0C6zY8YV93oZB3x0zC/LPbRYpF8f6OqX1lZj5vo2zJZy4fI/\\nkKcI5jHYc8VJq+KCuRZrvn+3V+KuL9tF9v8ZgjF2PZbU+LsCy5Yqg1M8f5Jp5f6V\\nu4QuUoobAgMBAAE=\\n-----END PUBLIC KEY-----"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "MULTILINE_PEM_DOUBLE": "-----BEGIN PUBLIC KEY-----\\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnNl1tL3QjKp3DZWM0T3u\\nLgGJQwu9WqyzHKZ6WIA5T+7zPjO1L8l3S8k8YzBrfH4mqWOD1GBI8Yjq2L1ac3Y/\\nbTdfHN8CmQr2iDJC0C6zY8YV93oZB3x0zC/LPbRYpF8f6OqX1lZj5vo2zJZy4fI/\\nkKcI5jHYc8VJq+KCuRZrvn+3V+KuL9tF9v8ZgjF2PZbU+LsCy5Yqg1M8f5Jp5f6V\\nu4QuUoobAgMBAAE=\\n-----END PUBLIC KEY-----"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "MULTILINE_PEM_DOUBLE": "-----BEGIN PUBLIC KEY-----\\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnNl1tL3QjKp3DZWM0T3u\\nLgGJQwu9WqyzHKZ6WIA5T+7zPjO1L8l3S8k8YzBrfH4mqWOD1GBI8Yjq2L1ac3Y/\\nbTdfHN8CmQr2iDJC0C6zY8YV93oZB3x0zC/LPbRYpF8f6OqX1lZj5vo2zJZy4fI/\\nkKcI5jHYc8VJq+KCuRZrvn+3V+KuL9tF9v8ZgjF2PZbU+LsCy5Yqg1M8f5Jp5f6V\\nu4QuUoobAgMBAAE=\\n-----END PUBLIC KEY-----"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "MULTILINE_PEM_DOUBLE": "-----BEGIN PUBLIC KEY-----\\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnNl1tL3QjKp3DZWM0T3u\\nLgGJQwu9WqyzHKZ6WIA5T+7zPjO1L8l3S8k8YzBrfH4mqWOD1GBI8Yjq2L1ac3Y/\\nbTdfHN8CmQr2iDJC0C6zY8YV93oZB3x0zC/LPbRYpF8f6OqX1lZj5vo2zJZy4fI/\\nkKcI5jHYc8VJq+KCuRZrvn+3V+KuL9tF9v8ZgjF2PZbU+LsCy5Yqg1M8f5Jp5f6V\\nu4QuUoobAgMBAAE=\\n-----END PUBLIC KEY-----"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "MULTILINE_PEM_DOUBLE": "-----BEGIN PUBLIC KEY-----\\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnNl1tL3QjKp3DZWM0T3u\\nLgGJQwu9WqyzHKZ6WIA5T+7zPjO1L8l3S8k8YzBrfH4mqWOD1GBI8Yjq2L1ac3Y/\\nbTdfHN8CmQr2iDJC0C6zY8YV93oZB3x0zC/LPbRYpF8f6OqX1lZj5vo2zJZy4fI/\\nkKcI5jHYc8VJq+KCuRZrvn+3V+KuL9tF9v8ZgjF2PZbU+LsCy5Yqg1M8f5Jp5f6V\\nu4QuUoobAgMBAAE=\\n-----END PUBLIC KEY-----"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "MULTILINE_PEM_DOUBLE": "-----BEGIN PUBLIC KEY-----\\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnNl1tL3QjKp3DZWM0T3u\\nLgGJQwu9WqyzHKZ6WIA5T+7zPjO1L8l3S8k8YzBrfH4mqWOD1GBI8Yjq2L1ac3Y/\\nbTdfHN8CmQr2iDJC0C6zY8YV93oZB3x0zC/LPbRYpF8f6OqX1lZj5vo2zJZy4fI/\\nkKcI5jHYc8VJq+KCuRZrvn+3V+KuL9tF9v8ZgjF2PZbU+LsCy5Yqg1M8f5Jp5f6V\\nu4QuUoobAgMBAAE=\\n-----END PUBLIC KEY-----"\n}',
        },
      },
    },
    {
      scenario: '308_DOUBLE_QUOTES_WITH_SINGLE_QUOTES_INSIDE',
      env: "SINGLE_QUOTES_INSIDE_DOUBLE=\"single 'quotes' work inside double quotes\"\n",
      expected: "{\n  \"SINGLE_QUOTES_INSIDE_DOUBLE\": \"single 'quotes' work inside double quotes\"\n}",
      results: {
        dotenvx: {
          pass: true,
          output: "{\n  \"SINGLE_QUOTES_INSIDE_DOUBLE\": \"single 'quotes' work inside double quotes\"\n}",
        },
        docker: {
          pass: false,
          output: "{\n  \"SINGLE_QUOTES_INSIDE_DOUBLE\": \"\\\"single 'quotes' work inside double quotes\\\"\"\n}",
        },
        'docker-compose': {
          pass: true,
          output: "{\n  \"SINGLE_QUOTES_INSIDE_DOUBLE\": \"single 'quotes' work inside double quotes\"\n}",
        },
        'npm@dotenv': {
          pass: true,
          output: "{\n  \"SINGLE_QUOTES_INSIDE_DOUBLE\": \"single 'quotes' work inside double quotes\"\n}",
        },
        'npm@nextenv': {
          pass: true,
          output: "{\n  \"SINGLE_QUOTES_INSIDE_DOUBLE\": \"single 'quotes' work inside double quotes\"\n}",
        },
        'dotenv-ruby': {
          pass: true,
          output: "{\n  \"SINGLE_QUOTES_INSIDE_DOUBLE\": \"single 'quotes' work inside double quotes\"\n}",
        },
        'python-dotenv': {
          pass: true,
          output: "{\n  \"SINGLE_QUOTES_INSIDE_DOUBLE\": \"single 'quotes' work inside double quotes\"\n}",
        },
        phpdotenv: {
          pass: true,
          output: "{\n  \"SINGLE_QUOTES_INSIDE_DOUBLE\": \"single 'quotes' work inside double quotes\"\n}",
        },
        godotenv: {
          pass: true,
          output: "{\n  \"SINGLE_QUOTES_INSIDE_DOUBLE\": \"single 'quotes' work inside double quotes\"\n}",
        },
      },
    },
    {
      scenario: '309_DOUBLE_QUOTES_WITH_BACKTICKS_INSIDE',
      env: 'BACKTICKS_INSIDE_DOUBLE="`backticks` work inside double quotes"\n',
      expected: '{\n  "BACKTICKS_INSIDE_DOUBLE": "`backticks` work inside double quotes"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "BACKTICKS_INSIDE_DOUBLE": "`backticks` work inside double quotes"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "BACKTICKS_INSIDE_DOUBLE": "\\"`backticks` work inside double quotes\\""\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "BACKTICKS_INSIDE_DOUBLE": "`backticks` work inside double quotes"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "BACKTICKS_INSIDE_DOUBLE": "`backticks` work inside double quotes"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "BACKTICKS_INSIDE_DOUBLE": "`backticks` work inside double quotes"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "BACKTICKS_INSIDE_DOUBLE": "`backticks` work inside double quotes"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "BACKTICKS_INSIDE_DOUBLE": "`backticks` work inside double quotes"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "BACKTICKS_INSIDE_DOUBLE": "`backticks` work inside double quotes"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "BACKTICKS_INSIDE_DOUBLE": "`backticks` work inside double quotes"\n}',
        },
      },
    },
    {
      scenario: '310_DOUBLE_QUOTES_WITH_NO_SPACE_BRACKET',
      env: 'DOUBLE_QUOTES_WITH_NO_SPACE_BRACKET="{ port: $MONGOLAB_PORT}"\n',
      expected: '{\n  "DOUBLE_QUOTES_WITH_NO_SPACE_BRACKET": "{ port: }"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_WITH_NO_SPACE_BRACKET": "{ port: }"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "DOUBLE_QUOTES_WITH_NO_SPACE_BRACKET": "\\"{ port: $MONGOLAB_PORT}\\""\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_WITH_NO_SPACE_BRACKET": "{ port: }"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_WITH_NO_SPACE_BRACKET": "{ port: }"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "DOUBLE_QUOTES_WITH_NO_SPACE_BRACKET": "{ port: "\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "DOUBLE_QUOTES_WITH_NO_SPACE_BRACKET": "{ port: "\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "DOUBLE_QUOTES_WITH_NO_SPACE_BRACKET": "{ port: $MONGOLAB_PORT}"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "DOUBLE_QUOTES_WITH_NO_SPACE_BRACKET": "{ port: $MONGOLAB_PORT}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "DOUBLE_QUOTES_WITH_NO_SPACE_BRACKET": "{ port: "\n}',
        },
      },
    },
    {
      scenario: '311_DOUBLE_QUOTES_TWO_DOLLAR_SIGNS',
      env: 'TWO_DOLLAR_SIGNS="abcd$$1234"\n',
      expected: '{\n  "TWO_DOLLAR_SIGNS": "abcd$$1234"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "TWO_DOLLAR_SIGNS": "abcd$$1234"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "TWO_DOLLAR_SIGNS": "\\"abcd$$1234\\""\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "TWO_DOLLAR_SIGNS": "abcd$1234"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "TWO_DOLLAR_SIGNS": "abcd$$1234"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "TWO_DOLLAR_SIGNS": "abcd$"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "TWO_DOLLAR_SIGNS": "abcd$"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "TWO_DOLLAR_SIGNS": "abcd$$1234"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "TWO_DOLLAR_SIGNS": "abcd$$1234"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "TWO_DOLLAR_SIGNS": "abcd$"\n}',
        },
      },
    },
    {
      scenario: '401_BACKTICKS',
      env: 'BACKTICKS=`backticks`\n',
      expected: '{\n  "BACKTICKS": "backticks"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "BACKTICKS": "backticks"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "BACKTICKS": "`backticks`"\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "BACKTICKS": "`backticks`"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "BACKTICKS": "backticks"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "BACKTICKS": "backticks"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "BACKTICKS": "`backticks`"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "BACKTICKS": "`backticks`"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "BACKTICKS": "`backticks`"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "BACKTICKS": "`backticks`"\n}',
        },
      },
    },
    {
      scenario: '402_BACKTICKS_EMPTY',
      env: 'EMPTY=``\n',
      expected: '{\n  "EMPTY": ""\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EMPTY": "``"\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "EMPTY": "``"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EMPTY": "``"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "EMPTY": "``"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "EMPTY": ""\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EMPTY": "``"\n}',
        },
      },
    },
    {
      scenario: '403_BACKTICKS_SPACED',
      env: 'BACKTICKS_SPACED=`    backticks    `\n',
      expected: '{\n  "BACKTICKS_SPACED": "    backticks    "\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "BACKTICKS_SPACED": "    backticks    "\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "BACKTICKS_SPACED": "`    backticks    `"\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "BACKTICKS_SPACED": "`    backticks    `"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "BACKTICKS_SPACED": "    backticks    "\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "BACKTICKS_SPACED": "    backticks    "\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "BACKTICKS_SPACED": "`    backticks    `"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "BACKTICKS_SPACED": "`    backticks    `"\n}',
        },
        phpdotenv: {
          pass: false,
          output: null,
        },
        godotenv: {
          pass: false,
          output: '{\n  "BACKTICKS_SPACED": "`    backticks    `"\n}',
        },
      },
    },
    {
      scenario: '404_BACKTICKS_INLINE_COMMENT',
      env: 'INLINE_COMMENTS_BACKTICKS=`inline comments outside of #backticks` # work\n',
      expected: '{\n  "INLINE_COMMENTS_BACKTICKS": "inline comments outside of #backticks"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "INLINE_COMMENTS_BACKTICKS": "inline comments outside of #backticks"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "INLINE_COMMENTS_BACKTICKS": "`inline comments outside of #backticks` # work"\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "INLINE_COMMENTS_BACKTICKS": "`inline comments outside of"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "INLINE_COMMENTS_BACKTICKS": "inline comments outside of #backticks"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "INLINE_COMMENTS_BACKTICKS": "inline comments outside of #backticks"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "INLINE_COMMENTS_BACKTICKS": "`inline comments outside of"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "INLINE_COMMENTS_BACKTICKS": "`inline comments outside of"\n}',
        },
        phpdotenv: {
          pass: false,
          output: null,
        },
        godotenv: {
          pass: false,
          output: '{\n  "INLINE_COMMENTS_BACKTICKS": "`inline comments outside of #backticks`"\n}',
        },
      },
    },
    {
      scenario: '405_BACKTICKS_SINGLE_QUOTES_INSIDE',
      env: "SINGLE_QUOTES_INSIDE_BACKTICKS=`single 'quotes' work inside backticks`\n",
      expected: "{\n  \"SINGLE_QUOTES_INSIDE_BACKTICKS\": \"single 'quotes' work inside backticks\"\n}",
      results: {
        dotenvx: {
          pass: true,
          output: "{\n  \"SINGLE_QUOTES_INSIDE_BACKTICKS\": \"single 'quotes' work inside backticks\"\n}",
        },
        docker: {
          pass: false,
          output: "{\n  \"SINGLE_QUOTES_INSIDE_BACKTICKS\": \"`single 'quotes' work inside backticks`\"\n}",
        },
        'docker-compose': {
          pass: false,
          output: "{\n  \"SINGLE_QUOTES_INSIDE_BACKTICKS\": \"`single 'quotes' work inside backticks`\"\n}",
        },
        'npm@dotenv': {
          pass: true,
          output: "{\n  \"SINGLE_QUOTES_INSIDE_BACKTICKS\": \"single 'quotes' work inside backticks\"\n}",
        },
        'npm@nextenv': {
          pass: true,
          output: "{\n  \"SINGLE_QUOTES_INSIDE_BACKTICKS\": \"single 'quotes' work inside backticks\"\n}",
        },
        'dotenv-ruby': {
          pass: false,
          output: "{\n  \"SINGLE_QUOTES_INSIDE_BACKTICKS\": \"`single 'quotes' work inside backticks`\"\n}",
        },
        'python-dotenv': {
          pass: false,
          output: "{\n  \"SINGLE_QUOTES_INSIDE_BACKTICKS\": \"`single 'quotes' work inside backticks`\"\n}",
        },
        phpdotenv: {
          pass: false,
          output: null,
        },
        godotenv: {
          pass: false,
          output: "{\n  \"SINGLE_QUOTES_INSIDE_BACKTICKS\": \"`single 'quotes' work inside backticks`\"\n}",
        },
      },
    },
    {
      scenario: '406_BACKTICKS_DOUBLE_QUOTES_INSIDE',
      env: 'DOUBLE_QUOTES_INSIDE_BACKTICKS=`double "quotes" work inside backticks`\n',
      expected: '{\n  "DOUBLE_QUOTES_INSIDE_BACKTICKS": "double \\"quotes\\" work inside backticks"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_INSIDE_BACKTICKS": "double \\"quotes\\" work inside backticks"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "DOUBLE_QUOTES_INSIDE_BACKTICKS": "`double \\"quotes\\" work inside backticks`"\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "DOUBLE_QUOTES_INSIDE_BACKTICKS": "`double \\"quotes\\" work inside backticks`"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_INSIDE_BACKTICKS": "double \\"quotes\\" work inside backticks"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "DOUBLE_QUOTES_INSIDE_BACKTICKS": "double \\"quotes\\" work inside backticks"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "DOUBLE_QUOTES_INSIDE_BACKTICKS": "`double \\"quotes\\" work inside backticks`"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "DOUBLE_QUOTES_INSIDE_BACKTICKS": "`double \\"quotes\\" work inside backticks`"\n}',
        },
        phpdotenv: {
          pass: false,
          output: null,
        },
        godotenv: {
          pass: false,
          output: '{\n  "DOUBLE_QUOTES_INSIDE_BACKTICKS": "`double \\"quotes\\" work inside backticks`"\n}',
        },
      },
    },
    {
      scenario: '407_BACKTICKS_DOUBLE_AND_SINGLE_QUOTES_INSIDE',
      env: "DOUBLE_AND_SINGLE_QUOTES_INSIDE_BACKTICKS=`double \"quotes\" and single 'quotes' work inside backticks`\n",
      expected: "{\n  \"DOUBLE_AND_SINGLE_QUOTES_INSIDE_BACKTICKS\": \"double \\\"quotes\\\" and single 'quotes' work inside backticks\"\n}",
      results: {
        dotenvx: {
          pass: true,
          output: "{\n  \"DOUBLE_AND_SINGLE_QUOTES_INSIDE_BACKTICKS\": \"double \\\"quotes\\\" and single 'quotes' work inside backticks\"\n}",
        },
        docker: {
          pass: false,
          output: "{\n  \"DOUBLE_AND_SINGLE_QUOTES_INSIDE_BACKTICKS\": \"`double \\\"quotes\\\" and single 'quotes' work inside backticks`\"\n}",
        },
        'docker-compose': {
          pass: false,
          output: "{\n  \"DOUBLE_AND_SINGLE_QUOTES_INSIDE_BACKTICKS\": \"`double \\\"quotes\\\" and single 'quotes' work inside backticks`\"\n}",
        },
        'npm@dotenv': {
          pass: true,
          output: "{\n  \"DOUBLE_AND_SINGLE_QUOTES_INSIDE_BACKTICKS\": \"double \\\"quotes\\\" and single 'quotes' work inside backticks\"\n}",
        },
        'npm@nextenv': {
          pass: true,
          output: "{\n  \"DOUBLE_AND_SINGLE_QUOTES_INSIDE_BACKTICKS\": \"double \\\"quotes\\\" and single 'quotes' work inside backticks\"\n}",
        },
        'dotenv-ruby': {
          pass: false,
          output: "{\n  \"DOUBLE_AND_SINGLE_QUOTES_INSIDE_BACKTICKS\": \"`double \\\"quotes\\\" and single 'quotes' work inside backticks`\"\n}",
        },
        'python-dotenv': {
          pass: false,
          output: "{\n  \"DOUBLE_AND_SINGLE_QUOTES_INSIDE_BACKTICKS\": \"`double \\\"quotes\\\" and single 'quotes' work inside backticks`\"\n}",
        },
        phpdotenv: {
          pass: false,
          output: null,
        },
        godotenv: {
          pass: false,
          output: "{\n  \"DOUBLE_AND_SINGLE_QUOTES_INSIDE_BACKTICKS\": \"`double \\\"quotes\\\" and single 'quotes' work inside backticks`\"\n}",
        },
      },
    },
    {
      scenario: '408_BACKTICKS_RETAIN_INNER_QUOTES',
      env: "RETAIN_INNER_QUOTES_AS_BACKTICKS=`{\"foo\": \"bar's\"}`\n",
      expected: "{\n  \"RETAIN_INNER_QUOTES_AS_BACKTICKS\": \"{\\\"foo\\\": \\\"bar's\\\"}\"\n}",
      results: {
        dotenvx: {
          pass: true,
          output: "{\n  \"RETAIN_INNER_QUOTES_AS_BACKTICKS\": \"{\\\"foo\\\": \\\"bar's\\\"}\"\n}",
        },
        docker: {
          pass: false,
          output: "{\n  \"RETAIN_INNER_QUOTES_AS_BACKTICKS\": \"`{\\\"foo\\\": \\\"bar's\\\"}`\"\n}",
        },
        'docker-compose': {
          pass: false,
          output: "{\n  \"RETAIN_INNER_QUOTES_AS_BACKTICKS\": \"`{\\\"foo\\\": \\\"bar's\\\"}`\"\n}",
        },
        'npm@dotenv': {
          pass: true,
          output: "{\n  \"RETAIN_INNER_QUOTES_AS_BACKTICKS\": \"{\\\"foo\\\": \\\"bar's\\\"}\"\n}",
        },
        'npm@nextenv': {
          pass: true,
          output: "{\n  \"RETAIN_INNER_QUOTES_AS_BACKTICKS\": \"{\\\"foo\\\": \\\"bar's\\\"}\"\n}",
        },
        'dotenv-ruby': {
          pass: false,
          output: "{\n  \"RETAIN_INNER_QUOTES_AS_BACKTICKS\": \"`{\\\"foo\\\": \\\"bar's\\\"}`\"\n}",
        },
        'python-dotenv': {
          pass: false,
          output: "{\n  \"RETAIN_INNER_QUOTES_AS_BACKTICKS\": \"`{\\\"foo\\\": \\\"bar's\\\"}`\"\n}",
        },
        phpdotenv: {
          pass: false,
          output: null,
        },
        godotenv: {
          pass: false,
          output: "{\n  \"RETAIN_INNER_QUOTES_AS_BACKTICKS\": \"`{\\\"foo\\\": \\\"bar's\\\"}`\"\n}",
        },
      },
    },
    {
      scenario: '501_EXPAND',
      env: 'BASIC=basic\nBASIC_EXPAND=$BASIC\n',
      expected: '{\n  "BASIC": "basic",\n  "BASIC_EXPAND": "basic"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "BASIC": "basic",\n  "BASIC_EXPAND": "basic"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "BASIC_EXPAND": "$BASIC"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "BASIC": "basic",\n  "BASIC_EXPAND": "basic"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "BASIC": "basic",\n  "BASIC_EXPAND": "basic"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "BASIC": "basic",\n  "BASIC_EXPAND": "basic"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "BASIC": "basic",\n  "BASIC_EXPAND": "basic"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "BASIC_EXPAND": "$BASIC"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "BASIC_EXPAND": "$BASIC"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "BASIC": "basic",\n  "BASIC_EXPAND": "basic"\n}',
        },
      },
    },
    {
      scenario: '502_EXPAND_MACHINE',
      env: 'MACHINE=file\nMACHINE_EXPAND=$MACHINE\n',
      expected: '{\n  "MACHINE": "machine",\n  "MACHINE_EXPAND": "machine"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "MACHINE": "machine",\n  "MACHINE_EXPAND": "machine"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "MACHINE": "machine",\n  "MACHINE_EXPAND": "$MACHINE"\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "MACHINE": "machine",\n  "MACHINE_EXPAND": "file"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "MACHINE": "machine",\n  "MACHINE_EXPAND": "machine"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "MACHINE": "machine",\n  "MACHINE_EXPAND": "machine"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "MACHINE": "machine",\n  "MACHINE_EXPAND": "machine"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "MACHINE": "machine",\n  "MACHINE_EXPAND": "$MACHINE"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "MACHINE_EXPAND": "$MACHINE"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "MACHINE": "machine",\n  "MACHINE_EXPAND": "file"\n}',
        },
      },
    },
    {
      scenario: '503_EXPAND_FILE',
      env: 'FILE=file\nFILE_EXPAND=$FILE\n',
      expected: '{\n  "FILE": "file",\n  "FILE_EXPAND": "file"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "FILE": "file",\n  "FILE_EXPAND": "file"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "FILE": "file",\n  "FILE_EXPAND": "$FILE"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "FILE": "file",\n  "FILE_EXPAND": "file"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "FILE": "file",\n  "FILE_EXPAND": "file"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "FILE": "file",\n  "FILE_EXPAND": "file"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "FILE": "file",\n  "FILE_EXPAND": "file"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "FILE": "file",\n  "FILE_EXPAND": "$FILE"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "FILE": "file",\n  "FILE_EXPAND": "$FILE"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "FILE": "file",\n  "FILE_EXPAND": "file"\n}',
        },
      },
    },
    {
      scenario: '504_EXPAND_PARENTHESES',
      env: "# https://github.com/bkeepers/dotenv/pull/526\nPARENTHESES='passwo(rd'\nPARENTHESES_EXPAND=\"$(echo \"$PARENTHESES\")\"\n",
      expected: '{\n  "PARENTHESES": "passwo(rd",\n  "PARENTHESES_EXPAND": "passwo(rd"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "PARENTHESES": "passwo(rd",\n  "PARENTHESES_EXPAND": "passwo(rd"\n}',
        },
        docker: {
          pass: false,
          output: "{\n  \"PARENTHESES\": \"'passwo(rd'\",\n  \"PARENTHESES_EXPAND\": \"\\\"$(echo \\\"$PARENTHESES\\\")\\\"\"\n}",
        },
        'docker-compose': {
          pass: false,
          output: null,
        },
        'npm@dotenv': {
          pass: false,
          output: '{\n  "PARENTHESES": "passwo(rd",\n  "PARENTHESES_EXPAND": "$(echo \\"passwo(rd\\")"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "PARENTHESES": "passwo(rd",\n  "PARENTHESES_EXPAND": "$(echo \\"passwo(rd\\")"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "PARENTHESES": "passwo(rd",\n  "PARENTHESES_EXPAND": "$(echo \\"passwo(rd\\")"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "PARENTHESES": "passwo(rd"\n}',
        },
        phpdotenv: {
          pass: false,
          output: null,
        },
        godotenv: {
          pass: false,
          output: null,
        },
      },
    },
    {
      scenario: '505_EXPAND_RETAIN_INNER_QUOTES',
      env: '# https://github.com/bkeepers/dotenv/issues/530\n# Command substitution double-quote expansion\nRETAIN_INNER_QUOTES={"foo": "bar"}\nRETAIN_INNER_QUOTES_EXPAND="$(echo "$RETAIN_INNER_QUOTES")"\n',
      expected: '{\n  "RETAIN_INNER_QUOTES": "{\\"foo\\": \\"bar\\"}",\n  "RETAIN_INNER_QUOTES_EXPAND": "{\\"foo\\": \\"bar\\"}"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "RETAIN_INNER_QUOTES": "{\\"foo\\": \\"bar\\"}",\n  "RETAIN_INNER_QUOTES_EXPAND": "{\\"foo\\": \\"bar\\"}"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "RETAIN_INNER_QUOTES": "{\\"foo\\": \\"bar\\"}",\n  "RETAIN_INNER_QUOTES_EXPAND": "\\"$(echo \\"$RETAIN_INNER_QUOTES\\")\\""\n}',
        },
        'docker-compose': {
          pass: false,
          output: null,
        },
        'npm@dotenv': {
          pass: false,
          output: '{\n  "RETAIN_INNER_QUOTES": "{\\"foo\\": \\"bar\\"}",\n  "RETAIN_INNER_QUOTES_EXPAND": "$(echo \\"{\\"foo\\": \\"bar\\"}\\")"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "RETAIN_INNER_QUOTES": "{\\"foo\\": \\"bar\\"}",\n  "RETAIN_INNER_QUOTES_EXPAND": "$(echo \\"{\\"foo\\": \\"bar\\"}\\")"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "RETAIN_INNER_QUOTES": "{\\"foo\\": \\"bar\\"}",\n  "RETAIN_INNER_QUOTES_EXPAND": "{foo: bar}"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "RETAIN_INNER_QUOTES": "{\\"foo\\": \\"bar\\"}"\n}',
        },
        phpdotenv: {
          pass: false,
          output: null,
        },
        godotenv: {
          pass: false,
          output: null,
        },
      },
    },
    {
      scenario: '506_EXPAND_SINGLE_QUOTES_RETAIN_INNER_QUOTES',
      env: "RETAIN_INNER_QUOTES_AS_STRING='{\"foo\": \"bar\"}'\nRETAIN_INNER_QUOTES_AS_STRING_EXPAND=\"$(echo \"$RETAIN_INNER_QUOTES_AS_STRING\")\"\n",
      expected: '{\n  "RETAIN_INNER_QUOTES_AS_STRING": "{\\"foo\\": \\"bar\\"}",\n  "RETAIN_INNER_QUOTES_AS_STRING_EXPAND": "{\\"foo\\": \\"bar\\"}"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "RETAIN_INNER_QUOTES_AS_STRING": "{\\"foo\\": \\"bar\\"}",\n  "RETAIN_INNER_QUOTES_AS_STRING_EXPAND": "{\\"foo\\": \\"bar\\"}"\n}',
        },
        docker: {
          pass: false,
          output: "{\n  \"RETAIN_INNER_QUOTES_AS_STRING\": \"'{\\\"foo\\\": \\\"bar\\\"}'\",\n  \"RETAIN_INNER_QUOTES_AS_STRING_EXPAND\": \"\\\"$(echo \\\"$RETAIN_INNER_QUOTES_AS_STRING\\\")\\\"\"\n}",
        },
        'docker-compose': {
          pass: false,
          output: null,
        },
        'npm@dotenv': {
          pass: false,
          output: '{\n  "RETAIN_INNER_QUOTES_AS_STRING": "{\\"foo\\": \\"bar\\"}",\n  "RETAIN_INNER_QUOTES_AS_STRING_EXPAND": "$(echo \\"{\\"foo\\": \\"bar\\"}\\")"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "RETAIN_INNER_QUOTES_AS_STRING": "{\\"foo\\": \\"bar\\"}",\n  "RETAIN_INNER_QUOTES_AS_STRING_EXPAND": "$(echo \\"{\\"foo\\": \\"bar\\"}\\")"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "RETAIN_INNER_QUOTES_AS_STRING": "{\\"foo\\": \\"bar\\"}",\n  "RETAIN_INNER_QUOTES_AS_STRING_EXPAND": "{foo: bar}"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "RETAIN_INNER_QUOTES_AS_STRING": "{\\"foo\\": \\"bar\\"}"\n}',
        },
        phpdotenv: {
          pass: false,
          output: null,
        },
        godotenv: {
          pass: false,
          output: null,
        },
      },
    },
    {
      scenario: '507_EXPAND_ESCAPED',
      env: 'ESCAPED_EXPAND=\\$ESCAPED\n',
      expected: '{\n  "ESCAPED_EXPAND": "$ESCAPED"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "ESCAPED_EXPAND": "$ESCAPED"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "ESCAPED_EXPAND": "\\\\$ESCAPED"\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "ESCAPED_EXPAND": "\\\\"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "ESCAPED_EXPAND": "$ESCAPED"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "ESCAPED_EXPAND": "$ESCAPED"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "ESCAPED_EXPAND": "$ESCAPED"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "ESCAPED_EXPAND": "\\\\$ESCAPED"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "ESCAPED_EXPAND": "\\\\$ESCAPED"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "ESCAPED_EXPAND": "$ESCAPED"\n}',
        },
      },
    },
    {
      scenario: '508_EXPAND_NO_QUOTES_COMBOS',
      env: 'ONE=one\nTWO=two\nONETWO=${ONE}${TWO}\nONETWO_SIMPLE=${ONE}$TWO\nONETWO_SIMPLE2=$ONE${TWO}\nONETWO_SUPER_SIMPLE=$ONE$TWO\n',
      expected: '{\n  "ONE": "one",\n  "TWO": "two",\n  "ONETWO": "onetwo",\n  "ONETWO_SIMPLE": "onetwo",\n  "ONETWO_SIMPLE2": "onetwo",\n  "ONETWO_SUPER_SIMPLE": "onetwo"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "ONE": "one",\n  "TWO": "two",\n  "ONETWO": "onetwo",\n  "ONETWO_SIMPLE": "onetwo",\n  "ONETWO_SIMPLE2": "onetwo",\n  "ONETWO_SUPER_SIMPLE": "onetwo"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "ONE": "one",\n  "TWO": "two",\n  "ONETWO": "${ONE}${TWO}",\n  "ONETWO_SIMPLE": "${ONE}$TWO",\n  "ONETWO_SIMPLE2": "$ONE${TWO}",\n  "ONETWO_SUPER_SIMPLE": "$ONE$TWO"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "ONE": "one",\n  "TWO": "two",\n  "ONETWO": "onetwo",\n  "ONETWO_SIMPLE": "onetwo",\n  "ONETWO_SIMPLE2": "onetwo",\n  "ONETWO_SUPER_SIMPLE": "onetwo"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "ONE": "one",\n  "TWO": "two",\n  "ONETWO": "onetwo",\n  "ONETWO_SIMPLE": "onetwo",\n  "ONETWO_SIMPLE2": "onetwo",\n  "ONETWO_SUPER_SIMPLE": "onetwo"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "ONE": "one",\n  "TWO": "two",\n  "ONETWO": "onetwo",\n  "ONETWO_SIMPLE": "onetwo",\n  "ONETWO_SIMPLE2": "",\n  "ONETWO_SUPER_SIMPLE": ""\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "ONE": "one",\n  "TWO": "two",\n  "ONETWO": "onetwo",\n  "ONETWO_SIMPLE": "onetwo",\n  "ONETWO_SIMPLE2": "onetwo",\n  "ONETWO_SUPER_SIMPLE": "onetwo"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "ONE": "one",\n  "TWO": "two",\n  "ONETWO": "onetwo",\n  "ONETWO_SIMPLE": "one$TWO",\n  "ONETWO_SIMPLE2": "$ONEtwo",\n  "ONETWO_SUPER_SIMPLE": "$ONE$TWO"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "ONE": "one",\n  "TWO": "two",\n  "ONETWO": "onetwo",\n  "ONETWO_SIMPLE": "one$TWO",\n  "ONETWO_SIMPLE2": "$ONEtwo",\n  "ONETWO_SUPER_SIMPLE": "$ONE$TWO"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "ONE": "one",\n  "ONETWO": "onetwo",\n  "ONETWO_SIMPLE": "onetwo",\n  "ONETWO_SIMPLE2": "onetwo",\n  "ONETWO_SUPER_SIMPLE": "onetwo",\n  "TWO": "two"\n}',
        },
      },
    },
    {
      scenario: '509_EXPAND_SELF',
      env: 'EXPAND_SELF=$EXPAND_SELF\n',
      expected: '{\n  "EXPAND_SELF": ""\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_SELF": ""\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_SELF": "$EXPAND_SELF"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "EXPAND_SELF": ""\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_SELF": ""\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "EXPAND_SELF": ""\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "EXPAND_SELF": "$EXPAND_SELF"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_SELF": "$EXPAND_SELF"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "EXPAND_SELF": ""\n}',
        },
      },
    },
    {
      scenario: '510_EXPAND_URI',
      env: 'MONGOLAB_DATABASE=heroku_db\nMONGOLAB_USER=username\nMONGOLAB_PASSWORD=password\nMONGOLAB_DOMAIN=abcd1234.mongolab.com\nMONGOLAB_PORT=12345\nMONGOLAB_URI=mongodb://${MONGOLAB_USER}:${MONGOLAB_PASSWORD}@${MONGOLAB_DOMAIN}:${MONGOLAB_PORT}/${MONGOLAB_DATABASE}\n',
      expected: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://${MONGOLAB_USER}:${MONGOLAB_PASSWORD}@${MONGOLAB_DOMAIN}:${MONGOLAB_PORT}/${MONGOLAB_DATABASE}"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db",\n  "MONGOLAB_USER": "username"\n}',
        },
      },
    },
    {
      scenario: '511_EXPAND_URI_RECURSIVE',
      env: 'MONGOLAB_DATABASE=heroku_db\nMONGOLAB_USER=username\nMONGOLAB_PASSWORD=password\nMONGOLAB_DOMAIN=abcd1234.mongolab.com\nMONGOLAB_PORT=12345\nMONGOLAB_USER_RECURSIVE=${MONGOLAB_USER}:${MONGOLAB_PASSWORD}\nMONGOLAB_URI_RECURSIVE=mongodb://${MONGOLAB_USER_RECURSIVE}@${MONGOLAB_DOMAIN}:${MONGOLAB_PORT}/${MONGOLAB_DATABASE}\n',
      expected: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_USER_RECURSIVE": "username:password",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_USER_RECURSIVE": "username:password",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_USER_RECURSIVE": "${MONGOLAB_USER}:${MONGOLAB_PASSWORD}",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://${MONGOLAB_USER_RECURSIVE}@${MONGOLAB_DOMAIN}:${MONGOLAB_PORT}/${MONGOLAB_DATABASE}"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_USER_RECURSIVE": "username:password",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_USER_RECURSIVE": "username:password",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_USER_RECURSIVE": "username:password",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_USER_RECURSIVE": "username:password",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_USER_RECURSIVE": "username:password",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_USER_RECURSIVE": "username:password",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_USER_RECURSIVE": "username:password"\n}',
        },
      },
    },
    {
      scenario: '512_EXPAND_URI_NO_CURLY_BRACES',
      env: 'MONGOLAB_DATABASE=heroku_db\nMONGOLAB_USER=username\nMONGOLAB_PASSWORD=password\nMONGOLAB_DOMAIN=abcd1234.mongolab.com\nMONGOLAB_PORT=12345\nMONGOLAB_URI=mongodb://$MONGOLAB_USER:$MONGOLAB_PASSWORD@$MONGOLAB_DOMAIN:$MONGOLAB_PORT/$MONGOLAB_DATABASE\n',
      expected: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://$MONGOLAB_USER:$MONGOLAB_PASSWORD@$MONGOLAB_DOMAIN:$MONGOLAB_PORT/$MONGOLAB_DATABASE"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://$MONGOLAB_USER:$MONGOLAB_PASSWORD@$MONGOLAB_DOMAIN:$MONGOLAB_PORT/$MONGOLAB_DATABASE"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db",\n  "MONGOLAB_USER": "username"\n}',
        },
      },
    },
    {
      scenario: '513_EXPAND_URI_RECURSIVE_NO_CURLY_BRACES',
      env: 'MONGOLAB_DATABASE=heroku_db\nMONGOLAB_USER=username\nMONGOLAB_PASSWORD=password\nMONGOLAB_DOMAIN=abcd1234.mongolab.com\nMONGOLAB_PORT=12345\nMONGOLAB_USER_RECURSIVE=$MONGOLAB_USER:$MONGOLAB_PASSWORD\nMONGOLAB_URI_RECURSIVE=mongodb://$MONGOLAB_USER_RECURSIVE@$MONGOLAB_DOMAIN:$MONGOLAB_PORT/$MONGOLAB_DATABASE\n',
      expected: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_USER_RECURSIVE": "username:password",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_USER_RECURSIVE": "username:password",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_USER_RECURSIVE": "$MONGOLAB_USER:$MONGOLAB_PASSWORD",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://$MONGOLAB_USER_RECURSIVE@$MONGOLAB_DOMAIN:$MONGOLAB_PORT/$MONGOLAB_DATABASE"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_USER_RECURSIVE": "username:password",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_USER_RECURSIVE": "username:password",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_USER_RECURSIVE": "username:password",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_USER_RECURSIVE": "username:password",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_USER_RECURSIVE": "$MONGOLAB_USER:$MONGOLAB_PASSWORD",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://$MONGOLAB_USER_RECURSIVE@$MONGOLAB_DOMAIN:$MONGOLAB_PORT/$MONGOLAB_DATABASE"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_USER_RECURSIVE": "username:password",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "MONGOLAB_DATABASE": "heroku_db",\n  "MONGOLAB_DOMAIN": "abcd1234.mongolab.com",\n  "MONGOLAB_PASSWORD": "password",\n  "MONGOLAB_PORT": "12345",\n  "MONGOLAB_URI_RECURSIVE": "mongodb://username:password@abcd1234.mongolab.com:12345/heroku_db",\n  "MONGOLAB_USER": "username",\n  "MONGOLAB_USER_RECURSIVE": "username:password"\n}',
        },
      },
    },
    {
      scenario: '514_EXPAND_DOTS',
      env: 'POSTGRESQL.BASE.USER=postgres\nPOSTGRESQL.MAIN.USER=${POSTGRESQL.BASE.USER}\n',
      expected: '{\n  "POSTGRESQL.BASE.USER": "postgres",\n  "POSTGRESQL.MAIN.USER": "postgres"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "POSTGRESQL.BASE.USER": "postgres",\n  "POSTGRESQL.MAIN.USER": "postgres"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "POSTGRESQL.BASE.USER": "postgres",\n  "POSTGRESQL.MAIN.USER": "${POSTGRESQL.BASE.USER}"\n}',
        },
        'docker-compose': {
          pass: false,
          output: null,
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "POSTGRESQL.BASE.USER": "postgres",\n  "POSTGRESQL.MAIN.USER": "postgres"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "POSTGRESQL.BASE.USER": "postgres",\n  "POSTGRESQL.MAIN.USER": ".BASE.USER}"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "POSTGRESQL.BASE.USER": "postgres",\n  "POSTGRESQL.MAIN.USER": ".BASE.USER}"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "POSTGRESQL.BASE.USER": "postgres",\n  "POSTGRESQL.MAIN.USER": "postgres"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "POSTGRESQL.BASE.USER": "postgres",\n  "POSTGRESQL.MAIN.USER": "postgres"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "POSTGRESQL.BASE.USER": "postgres",\n  "POSTGRESQL.MAIN.USER": ".BASE.USER}"\n}',
        },
      },
    },
    {
      scenario: '515_EXPAND_NOT_FOR_SINGLE_QUOTE',
      env: "SINGLE_QUOTE='$BASIC'\n",
      expected: '{\n  "SINGLE_QUOTE": "$BASIC"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "SINGLE_QUOTE": "$BASIC"\n}',
        },
        docker: {
          pass: false,
          output: "{\n  \"SINGLE_QUOTE\": \"'$BASIC'\"\n}",
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "SINGLE_QUOTE": "$BASIC"\n}',
        },
        'npm@dotenv': {
          pass: false,
          output: '{\n  "SINGLE_QUOTE": ""\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "SINGLE_QUOTE": ""\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "SINGLE_QUOTE": "$BASIC"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "SINGLE_QUOTE": "$BASIC"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "SINGLE_QUOTE": "$BASIC"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "SINGLE_QUOTE": "$BASIC"\n}',
        },
      },
    },
    {
      scenario: '516_EXPAND_PROGRESSIVE',
      env: 'PROGRESSIVE=first\nPROGRESSIVE=${PROGRESSIVE}-second\n',
      expected: '{\n  "PROGRESSIVE": "first-second"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "PROGRESSIVE": "first-second"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "PROGRESSIVE": "${PROGRESSIVE}-second"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "PROGRESSIVE": "first-second"\n}',
        },
        'npm@dotenv': {
          pass: false,
          output: '{\n  "PROGRESSIVE": "-second"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "PROGRESSIVE": "first-second"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "PROGRESSIVE": "first-second"\n}',
        },
        phpdotenv: {
          pass: true,
          output: '{\n  "PROGRESSIVE": "first-second"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "PROGRESSIVE": "first-second"\n}',
        },
      },
    },
    {
      scenario: '517_EXPAND_DEFAULT',
      env: 'EXPAND_DEFAULT=${MACHINE:-default}\n',
      expected: '{\n  "EXPAND_DEFAULT": "machine"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT": "machine"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT": "${MACHINE:-default}"\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT": "default"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT": "machine"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT": "machine"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT": "machine:-default}"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT": "machine"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT": "${MACHINE:-default}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT": ":-default}"\n}',
        },
      },
    },
    {
      scenario: '518_EXPAND_DEFAULT2',
      env: 'EXPAND_DEFAULT2=${MACHINE-default}\n',
      expected: '{\n  "EXPAND_DEFAULT2": "machine"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT2": "machine"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT2": "${MACHINE-default}"\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT2": "default"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT2": "machine"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT2": "machine-default}"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT2": "machine-default}"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT2": ""\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT2": "${MACHINE-default}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT2": "-default}"\n}',
        },
      },
    },
    {
      scenario: '519_EXPAND_DEFAULT_NESTED',
      env: 'EXPAND_DEFAULT_NESTED=${MACHINE:-${UNDEFINED:-default}}\n',
      expected: '{\n  "EXPAND_DEFAULT_NESTED": "machine"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT_NESTED": "machine"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED": "${MACHINE:-${UNDEFINED:-default}}"\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED": "default"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT_NESTED": "machine"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT_NESTED": "machine"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED": "machine:-:-default}}"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED": "machine}"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED": "${MACHINE:-${UNDEFINED:-default}}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED": ":-:-default}}"\n}',
        },
      },
    },
    {
      scenario: '520_EXPAND_DEFAULT_NESTED2',
      env: 'EXPAND_DEFAULT_NESTED2=${MACHINE-${UNDEFINED-default}}\n',
      expected: '{\n  "EXPAND_DEFAULT_NESTED2": "machine"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT_NESTED2": "machine"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED2": "${MACHINE-${UNDEFINED-default}}"\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED2": "default"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT_NESTED2": "machine"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED2": "machine--default}}"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED2": "machine--default}}"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED2": "}"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED2": "${MACHINE-${UNDEFINED-default}}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED2": "--default}}"\n}',
        },
      },
    },
    {
      scenario: '521_EXPAND_DEFAULT_NESTED_TWICE',
      env: 'EXPAND_DEFAULT_NESTED_TWICE=${UNDEFINED:-${MACHINE}${UNDEFINED:-default}}\n',
      expected: '{\n  "EXPAND_DEFAULT_NESTED_TWICE": "machinedefault"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT_NESTED_TWICE": "machinedefault"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED_TWICE": "${UNDEFINED:-${MACHINE}${UNDEFINED:-default}}"\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED_TWICE": "default"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT_NESTED_TWICE": "machinedefault"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT_NESTED_TWICE": "machinedefault"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED_TWICE": ":-machine:-default}}"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED_TWICE": "${MACHINEdefault}"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED_TWICE": "${UNDEFINED:-machine${UNDEFINED:-default}}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED_TWICE": ":-:-default}}"\n}',
        },
      },
    },
    {
      scenario: '522_EXPAND_DEFAULT_NESTED_TWICE2',
      env: 'EXPAND_DEFAULT_NESTED_TWICE2=${UNDEFINED-${MACHINE}${UNDEFINED-default}}\n',
      expected: '{\n  "EXPAND_DEFAULT_NESTED_TWICE2": "machinedefault"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT_NESTED_TWICE2": "machinedefault"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED_TWICE2": "${UNDEFINED-${MACHINE}${UNDEFINED-default}}"\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED_TWICE2": "default"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT_NESTED_TWICE2": "machinedefault"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED_TWICE2": "-machine-default}}"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED_TWICE2": "-machine-default}}"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED_TWICE2": "}"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED_TWICE2": "${UNDEFINED-machine${UNDEFINED-default}}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_NESTED_TWICE2": "--default}}"\n}',
        },
      },
    },
    {
      scenario: '523_EXPAND_DEFAULT_SPECIAL_CHARACTERS',
      env: 'EXPAND_DEFAULT_SPECIAL_CHARACTERS=${MACHINE:-/default/path:with/colon}\n',
      expected: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS": "machine"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS": "machine"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS": "${MACHINE:-/default/path:with/colon}"\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS": "/default/path:with/colon"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS": "machine"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS": "machine"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS": "machine:-/default/path:with/colon}"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS": "machine"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS": "${MACHINE:-/default/path:with/colon}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS": ":-/default/path:with/colon}"\n}',
        },
      },
    },
    {
      scenario: '524_EXPAND_DEFAULT_SPECIAL_CHARACTERS2',
      env: 'EXPAND_DEFAULT_SPECIAL_CHARACTERS2=${MACHINE-/default/path:with/colon}\n',
      expected: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS2": "machine"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS2": "machine"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS2": "${MACHINE-/default/path:with/colon}"\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS2": "/default/path:with/colon"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS2": "machine"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS2": "machine-/default/path:with/colon}"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS2": "machine-/default/path:with/colon}"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS2": "${MACHINE-/default/path:with/colon}"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS2": "${MACHINE-/default/path:with/colon}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EXPAND_DEFAULT_SPECIAL_CHARACTERS2": "-/default/path:with/colon}"\n}',
        },
      },
    },
    {
      scenario: '525_EXPAND_UNDEFINED',
      env: 'EXPAND_UNDEFINED=$UNDEFINED\n',
      expected: '{\n  "EXPAND_UNDEFINED": ""\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED": ""\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED": "$UNDEFINED"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED": ""\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED": ""\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED": ""\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED": ""\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED": "$UNDEFINED"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED": "$UNDEFINED"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED": ""\n}',
        },
      },
    },
    {
      scenario: '526_EXPAND_UNDEFINED_NESTED',
      env: 'EXPAND_UNDEFINED_NESTED=${UNDEFINED:-${MACHINE:-default}}\n',
      expected: '{\n  "EXPAND_UNDEFINED_NESTED": "machine"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_NESTED": "machine"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_NESTED": "${UNDEFINED:-${MACHINE:-default}}"\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_NESTED": "default"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_NESTED": "machine"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_NESTED": "machine"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_NESTED": ":-machine:-default}}"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_NESTED": "${MACHINE:-default}"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_NESTED": "${UNDEFINED:-${MACHINE:-default}}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_NESTED": ":-:-default}}"\n}',
        },
      },
    },
    {
      scenario: '527_EXPAND_UNDEFINED_DEFAULT',
      env: 'EXPAND_UNDEFINED_DEFAULT=${UNDEFINED:-default}\n',
      expected: '{\n  "EXPAND_UNDEFINED_DEFAULT": "default"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT": "default"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT": "${UNDEFINED:-default}"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT": "default"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT": "default"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT": "default"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT": ":-default}"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT": "default"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT": "${UNDEFINED:-default}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT": ":-default}"\n}',
        },
      },
    },
    {
      scenario: '528_EXPAND_UNDEFINED_DEFAULT2',
      env: 'EXPAND_UNDEFINED_DEFAULT2=${UNDEFINED-default}\n',
      expected: '{\n  "EXPAND_UNDEFINED_DEFAULT2": "default"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2": "default"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2": "${UNDEFINED-default}"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2": "default"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2": "default"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2": "-default}"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2": "-default}"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2": ""\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2": "${UNDEFINED-default}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2": "-default}"\n}',
        },
      },
    },
    {
      scenario: '529_EXPAND_UNDEFINED_DEFAULT_NESTED',
      env: 'EXPAND_UNDEFINED_DEFAULT_NESTED=${UNDEFINED:-${UNDEFINED:-default}}\n',
      expected: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED": "default"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED": "default"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED": "${UNDEFINED:-${UNDEFINED:-default}}"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED": "default"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED": "default"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED": "default"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED": ":-:-default}}"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED": "${UNDEFINED:-default}"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED": "${UNDEFINED:-${UNDEFINED:-default}}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED": ":-:-default}}"\n}',
        },
      },
    },
    {
      scenario: '530_EXPAND_UNDEFINED_DEFAULT2_NESTED',
      env: 'EXPAND_UNDEFINED_DEFAULT2_NESTED=${UNDEFINED-${UNDEFINED-default}}\n',
      expected: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED": "default"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED": "default"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED": "${UNDEFINED-${UNDEFINED-default}}"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED": "default"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED": "default"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED": "--default}}"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED": "--default}}"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED": "}"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED": "${UNDEFINED-${UNDEFINED-default}}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED": "--default}}"\n}',
        },
      },
    },
    {
      scenario: '531_EXPAND_UNDEFINED_DEFAULT_NESTED_TWICE',
      env: 'EXPAND_UNDEFINED_DEFAULT_NESTED_TWICE=${UNDEFINED:-${UNDEFINED:-${UNDEFINED:-default}}}\n',
      expected: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED_TWICE": "default"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED_TWICE": "default"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED_TWICE": "${UNDEFINED:-${UNDEFINED:-${UNDEFINED:-default}}}"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED_TWICE": "default"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED_TWICE": "default"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED_TWICE": "default"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED_TWICE": ":-:-:-default}}}"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED_TWICE": "${UNDEFINED:-${UNDEFINED:-default}}"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED_TWICE": "${UNDEFINED:-${UNDEFINED:-${UNDEFINED:-default}}}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_NESTED_TWICE": ":-:-:-default}}}"\n}',
        },
      },
    },
    {
      scenario: '532_EXPAND_UNDEFINED_DEFAULT2_NESTED_TWICE',
      env: 'EXPAND_UNDEFINED_DEFAULT2_NESTED_TWICE=${UNDEFINED-${UNDEFINED-${UNDEFINED-default}}}\n',
      expected: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED_TWICE": "default"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED_TWICE": "default"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED_TWICE": "${UNDEFINED-${UNDEFINED-${UNDEFINED-default}}}"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED_TWICE": "default"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED_TWICE": "default"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED_TWICE": "---default}}}"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED_TWICE": "---default}}}"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED_TWICE": "}}"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED_TWICE": "${UNDEFINED-${UNDEFINED-${UNDEFINED-default}}}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_NESTED_TWICE": "---default}}}"\n}',
        },
      },
    },
    {
      scenario: '533_EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS',
      env: 'EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS=${UNDEFINED:-/default/path:with/colon}\n',
      expected: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS": "/default/path:with/colon"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS": "/default/path:with/colon"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS": "${UNDEFINED:-/default/path:with/colon}"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS": "/default/path:with/colon"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS": "/default/path:with/colon"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS": "/default/path:with/colon"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS": ":-/default/path:with/colon}"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS": "/default/path:with/colon"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS": "${UNDEFINED:-/default/path:with/colon}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS": ":-/default/path:with/colon}"\n}',
        },
      },
    },
    {
      scenario: '534_EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS',
      env: 'EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS=${UNDEFINED-/default/path:with/colon}\n\n',
      expected: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS": "/default/path:with/colon"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS": "/default/path:with/colon"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS": "${UNDEFINED-/default/path:with/colon}"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS": "/default/path:with/colon"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS": "/default/path:with/colon"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS": "-/default/path:with/colon}"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS": "-/default/path:with/colon}"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS": "${UNDEFINED-/default/path:with/colon}"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS": "${UNDEFINED-/default/path:with/colon}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS": "-/default/path:with/colon}"\n}',
        },
      },
    },
    {
      scenario: '535_EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS_NESTED',
      env: 'EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS_NESTED=${UNDEFINED:-${UNDEFINED_2:-/default/path:with/colon}}\n',
      expected: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS_NESTED": "/default/path:with/colon"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS_NESTED": "/default/path:with/colon"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS_NESTED": "${UNDEFINED:-${UNDEFINED_2:-/default/path:with/colon}}"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS_NESTED": "/default/path:with/colon"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS_NESTED": "/default/path:with/colon"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS_NESTED": "/default/path:with/colon"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS_NESTED": ":-:-/default/path:with/colon}}"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS_NESTED": "${UNDEFINED_2:-/default/path:with/colon}"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS_NESTED": "${UNDEFINED:-${UNDEFINED_2:-/default/path:with/colon}}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT_SPECIAL_CHARACTERS_NESTED": ":-:-/default/path:with/colon}}"\n}',
        },
      },
    },
    {
      scenario: '536_EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS_NESTED',
      env: 'EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS_NESTED=${UNDEFINED-${UNDEFINED_2-/default/path:with/colon}}\n',
      expected: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS_NESTED": "/default/path:with/colon"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS_NESTED": "/default/path:with/colon"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS_NESTED": "${UNDEFINED-${UNDEFINED_2-/default/path:with/colon}}"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS_NESTED": "/default/path:with/colon"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS_NESTED": "/default/path:with/colon"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS_NESTED": "--/default/path:with/colon}}"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS_NESTED": "--/default/path:with/colon}}"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS_NESTED": "${UNDEFINED-${UNDEFINED_2-/default/path:with/colon}}"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS_NESTED": "${UNDEFINED-${UNDEFINED_2-/default/path:with/colon}}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "EXPAND_UNDEFINED_DEFAULT2_SPECIAL_CHARACTERS_NESTED": "--/default/path:with/colon}}"\n}',
        },
      },
    },
    {
      scenario: '537_EXPAND_DEEP8',
      env: 'BASIC=basic\nEXPAND_DEEP8=${QUXX:-prefix5-${QUX:-prefix4-${BAZ:-prefix3-${BAR:-prefix2-${FOO:-prefix1-${BASIC:-test}-suffix1}-suffix2}-suffix3}-suffix4}-suffix5}\n',
      expected: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP8": "prefix5-prefix4-prefix3-prefix2-prefix1-basic-suffix1-suffix2-suffix3-suffix4-suffix5"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP8": "prefix5-prefix4-prefix3-prefix2-prefix1-basic-suffix1-suffix2-suffix3-suffix4-suffix5"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP8": "${QUXX:-prefix5-${QUX:-prefix4-${BAZ:-prefix3-${BAR:-prefix2-${FOO:-prefix1-${BASIC:-test}-suffix1}-suffix2}-suffix3}-suffix4}-suffix5}"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP8": "prefix5-prefix4-prefix3-prefix2-prefix1-basic-suffix1-suffix2-suffix3-suffix4-suffix5"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP8": "prefix5-prefix4-prefix3-prefix2-prefix1-basic-suffix1-suffix2-suffix3-suffix4-suffix5"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP8": "prefix5-prefix4-prefix3-prefix2-prefix1-test-suffix1-suffix2-suffix3-suffix4-suffix5"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP8": ":-prefix5-:-prefix4-:-prefix3-:-prefix2-:-prefix1-basic:-test}-suffix1}-suffix2}-suffix3}-suffix4}-suffix5}"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP8": "prefix5-${QUX:-prefix4-${BAZ:-prefix3-${BAR:-prefix2-${FOO:-prefix1-${BASIC:-test-suffix1}-suffix2}-suffix3}-suffix4}-suffix5}"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP8": "${QUXX:-prefix5-${QUX:-prefix4-${BAZ:-prefix3-${BAR:-prefix2-${FOO:-prefix1-${BASIC:-test}-suffix1}-suffix2}-suffix3}-suffix4}-suffix5}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP8": ":-prefix5-:-prefix4-:-prefix3-:-prefix2-:-prefix1-basic:-test}-suffix1}-suffix2}-suffix3}-suffix4}-suffix5}"\n}',
        },
      },
    },
    {
      scenario: '538_EXPAND_DEEP_SELF',
      env: 'BASIC=basic\nEXPAND_DEEP_SELF=${EXPAND_DEEP_SELF:-${BASIC:-test}-bar}\n',
      expected: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF": "basic-bar"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF": "basic-bar"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF": "${EXPAND_DEEP_SELF:-${BASIC:-test}-bar}"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF": "basic-bar"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF": "basic-bar"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF": "test-bar"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF": ":-basic:-test}-bar}"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF": "${BASIC:-test-bar}"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF": "${EXPAND_DEEP_SELF:-${BASIC:-test}-bar}"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF": ":-basic:-test}-bar}"\n}',
        },
      },
    },
    {
      scenario: '539_EXPAND_DEEP_SELF_PRIOR',
      env: 'BASIC=basic\nEXPAND_DEEP_SELF_PRIOR=foo\nEXPAND_DEEP_SELF_PRIOR=prefix2-${EXPAND_DEEP_SELF_PRIOR:-prefix1-${BASIC:-test}-suffix2}-suffix2\n',
      expected: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF_PRIOR": "prefix2-foo-suffix2"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF_PRIOR": "prefix2-foo-suffix2"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF_PRIOR": "prefix2-${EXPAND_DEEP_SELF_PRIOR:-prefix1-${BASIC:-test}-suffix2}-suffix2"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF_PRIOR": "prefix2-foo-suffix2"\n}',
        },
        'npm@dotenv': {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF_PRIOR": "prefix2-prefix1-basic-suffix2-suffix2"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF_PRIOR": "prefix2-prefix1-test-suffix2-suffix2"\n}',
        },
        'dotenv-ruby': {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF_PRIOR": "prefix2-foo:-prefix1-basic:-test}-suffix2}-suffix2"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF_PRIOR": "prefix2-foo-suffix2}-suffix2"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF_PRIOR": "prefix2-${EXPAND_DEEP_SELF_PRIOR:-prefix1-${BASIC:-test}-suffix2}-suffix2"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "BASIC": "basic",\n  "EXPAND_DEEP_SELF_PRIOR": "prefix2-foo:-prefix1-basic:-test}-suffix2}-suffix2"\n}',
        },
      },
    },
    {
      scenario: '601_EVAL',
      env: 'HELLO="$(echo world)"\n',
      expected: '{\n  "HELLO": "world"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "HELLO": "world"\n}',
        },
        docker: {
          pass: false,
          output: '{\n  "HELLO": "\\"$(echo world)\\""\n}',
        },
        'docker-compose': {
          pass: false,
          output: '{\n  "HELLO": "$(echo world)"\n}',
        },
        'npm@dotenv': {
          pass: false,
          output: '{\n  "HELLO": "$(echo world)"\n}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{\n  "HELLO": "$(echo world)"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "HELLO": "world"\n}',
        },
        'python-dotenv': {
          pass: false,
          output: '{\n  "HELLO": "$(echo world)"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "HELLO": "$(echo world)"\n}',
        },
        godotenv: {
          pass: false,
          output: '{\n  "HELLO": "$(echo world)"\n}',
        },
      },
    },
    {
      scenario: '901_LATIN1',
      env: 'HELLO=latin1',
      expected: '{\n  "HELLO": "latin1"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "HELLO": "latin1"\n}',
        },
        docker: {
          pass: true,
          output: '{\n  "HELLO": "latin1"\n}',
        },
        'docker-compose': {
          pass: true,
          output: '{\n  "HELLO": "latin1"\n}',
        },
        'npm@dotenv': {
          pass: true,
          output: '{\n  "HELLO": "latin1"\n}',
        },
        'npm@nextenv': {
          pass: true,
          output: '{\n  "HELLO": "latin1"\n}',
        },
        'dotenv-ruby': {
          pass: true,
          output: '{\n  "HELLO": "latin1"\n}',
        },
        'python-dotenv': {
          pass: true,
          output: '{\n  "HELLO": "latin1"\n}',
        },
        phpdotenv: {
          pass: false,
          output: '{\n  "HELLO": "$(echo world)"\n}',
        },
        godotenv: {
          pass: true,
          output: '{\n  "HELLO": "latin1"\n}',
        },
      },
    },
    {
      scenario: '902_UTF16LE',
      env: '��H\u0000E\u0000L\u0000L\u0000O\u0000=\u0000u\u0000t\u0000f\u00001\u00006\u0000l\u0000e\u0000\n\u0000',
      expected: '{\n  "HELLO": "utf16le"\n}',
      results: {
        dotenvx: {
          pass: true,
          output: '{\n  "HELLO": "utf16le"\n}',
        },
        docker: {
          pass: false,
          output: null,
        },
        'docker-compose': {
          pass: false,
          output: null,
        },
        'npm@dotenv': {
          pass: false,
          output: '{}',
        },
        'npm@nextenv': {
          pass: false,
          output: '{}',
        },
        'dotenv-ruby': {
          pass: false,
          output: null,
        },
        'python-dotenv': {
          pass: false,
          output: null,
        },
        phpdotenv: {
          pass: false,
          output: null,
        },
        godotenv: {
          pass: false,
          output: null,
        },
      },
    },
  ],
  percent_pass: {
    dotenvx: 100,
    docker: 13,
    'docker-compose': 63,
    'npm@dotenv': 90,
    'npm@nextenv': 72,
    'dotenv-ruby': 55,
    'python-dotenv': 52,
    phpdotenv: 43,
    godotenv: 52,
  },
};



let failCount = 0;
let testCount = 0;
for (const scenario of COMPARISON_SCENARIOS.scenarios) {
  const scenarioName = scenario.scenario;
  // skip expand tests for now until it is implemented
  if (scenarioName.includes('EXPAND') || scenarioName.includes('EVAL')) continue;
  testCount++;

  const input = scenario.env.replaceAll('\\n', '\n');
  try {
    const result = await parseEnvSpecDotEnvFile(input);
    const resultObj = result.toSimpleObj();
    const expectedObj = JSON.parse(scenario.expected
      .replaceAll('\\n', '__NEWLINE__')
      .replaceAll('\\n', '\n')
      .replaceAll('__NEWLINE__', '\\n'));

    if (util.isDeepStrictEqual(result.toSimpleObj(), expectedObj)) {
      // console.log('✅ MATCH');
    } else {
      failCount++;
      console.log(`\n❌ ${scenarioName} -----------------`);
      console.log(input);
      console.log('--');
      console.log('RESULT', resultObj);
      console.log('EXPECTED', expectedObj);
    }
  } catch (error) {
    failCount++;
    // console.log(error);
    console.log(`\n💥 ${scenarioName} - PARSING FAILED -----------------`);
    console.log(input);
    // console.log('ERROR', error);
  }
}
console.log(`${failCount} / ${testCount} scenarios have different results`);
console.log('(skipping expand tests for now)');
