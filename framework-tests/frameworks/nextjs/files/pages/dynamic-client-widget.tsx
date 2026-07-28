'use client';

import { useEffect, useState } from 'react';
import { ENV, loadPublicDynamicEnv } from 'varlock/env';

export function DynamicClientWidget() {
  const [flag, setFlag] = useState<string>('client-not-hydrated');
  useEffect(() => {
    loadPublicDynamicEnv().then(() => {
      setFlag(String((ENV as Record<string, unknown>).PUBLIC_DYNAMIC_VAR));
    }).catch(() => setFlag('load-failed'));
  }, []);
  return <p className="dynamic-widget">{flag}</p>;
}
