package server

import bootstrappkg "github.com/bsdrop/lafdb/internal/server/bootstrap"

func Run() {
	bootstrappkg.Run()
}

func GenerateAccessibleBitset(root, outPath string) {
	bootstrappkg.GenerateAccessibleBitset(root, outPath)
}
