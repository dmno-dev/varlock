import { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ENV } from 'varlock/env';

export default function HomeScreen() {
  const [serverResponse, setServerResponse] = useState<string | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [logResult, setLogResult] = useState<string | null>(null);

  async function callServerRoute() {
    try {
      const res = await fetch('/env');
      const data = await res.json();
      setServerResponse(JSON.stringify(data, null, 2));
    } catch (err) {
      setServerResponse(`Error: ${err}`);
    }
  }

  async function tryLogSensitiveVar() {
    try {
      const res = await fetch('/env', { method: 'POST' });
      const data = await res.json();
      setLogResult(JSON.stringify(data, null, 2));
    } catch (err) {
      setLogResult(`Error: ${err}`);
    }
  }

  function tryAccessSensitiveVar() {
    try {
      const value = ENV.SECRET_KEY;
      setClientError(`Unexpectedly got: ${value}`);
    } catch (err) {
      setClientError(String(err));
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{ENV.APP_NAME}</Text>

      <View style={styles.section}>
        <Text style={styles.heading}>Non-sensitive (inlined at build time)</Text>
        <Text style={styles.value}>APP_NAME: {ENV.APP_NAME}</Text>
        <Text style={styles.value}>API_URL: {ENV.API_URL}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.heading}>Sensitive (server route only)</Text>
        <Text style={styles.hint}>
          SECRET_KEY is @sensitive — it is NOT available in native code.
          Tap below to fetch it from the +api server route.
        </Text>
        <Pressable style={styles.button} onPress={callServerRoute}>
          <Text style={styles.buttonText}>Fetch /env from server</Text>
        </Pressable>
        {serverResponse && (
          <Text style={styles.code}>{serverResponse}</Text>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.heading}>Console log redaction</Text>
        <Text style={styles.hint}>
          varlock patches console.log to redact sensitive values. Tap below
          to log SECRET_KEY on the server and see the redacted output.
        </Text>
        <Pressable style={[styles.button, styles.purpleButton]} onPress={tryLogSensitiveVar}>
          <Text style={styles.buttonText}>Log SECRET_KEY on server</Text>
        </Pressable>
        {logResult && (
          <Text style={styles.code}>{logResult}</Text>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.heading}>What happens if you try on the client?</Text>
        <Text style={styles.hint}>
          Accessing a @sensitive var in client code throws at runtime.
          Tap below to see the error.
        </Text>
        <Pressable style={[styles.button, styles.dangerButton]} onPress={tryAccessSensitiveVar}>
          <Text style={styles.buttonText}>Try ENV.SECRET_KEY on client</Text>
        </Pressable>
        {clientError && (
          <Text style={styles.errorCode}>{clientError}</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, backgroundColor: '#f8f9fa' },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 24 },
  section: { marginBottom: 24, padding: 16, backgroundColor: '#fff', borderRadius: 8 },
  heading: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  value: { fontSize: 14, fontFamily: 'monospace', color: '#333', marginBottom: 4 },
  hint: { fontSize: 13, color: '#666', marginBottom: 12 },
  button: { backgroundColor: '#0066ff', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 6, alignSelf: 'flex-start' },
  buttonText: { color: '#fff', fontWeight: '600' },
  code: { marginTop: 12, fontSize: 12, fontFamily: 'monospace', backgroundColor: '#f0f0f0', padding: 12, borderRadius: 4 },
  purpleButton: { backgroundColor: '#7c3aed' },
  dangerButton: { backgroundColor: '#cc3333' },
  errorCode: { marginTop: 12, fontSize: 12, fontFamily: 'monospace', backgroundColor: '#fff0f0', color: '#cc0000', padding: 12, borderRadius: 4 },
});
