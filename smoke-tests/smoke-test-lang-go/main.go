package main

import (
	"fmt"
	"os"

	"smoketest/env"
)

func main() {
	e, err := env.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if e.Port != 8080 || !e.Debug {
		fmt.Fprintf(os.Stderr, "unexpected: port=%d debug=%t\n", e.Port, e.Debug)
		os.Exit(1)
	}
	if !env.SensitiveKeys["SECRET"] {
		fmt.Fprintln(os.Stderr, "SECRET not marked sensitive")
		os.Exit(1)
	}
	fmt.Println("OK")
}
