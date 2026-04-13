package logging

import (
	"encoding/json"
	"log"
	"net/http"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/mattn/go-isatty"
)

var enableLogging bool
var isTerminal = isatty.IsTerminal(os.Stdout.Fd()) || isatty.IsCygwinTerminal(os.Stdout.Fd())

// fallback list in case the API is unreachable at startup
var cfRangesFallback = []string{
	"173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
	"141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
	"197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
	"104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
	"2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
	"2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
}

var cfRanges []netip.Prefix

func SetEnabled(v bool) {
	enableLogging = v
}

func init() {
	initCFRanges()
}

func parsePrefixes(raw []string) []netip.Prefix {
	out := make([]netip.Prefix, 0, len(raw))
	for _, s := range raw {
		if p, err := netip.ParsePrefix(s); err == nil {
			out = append(out, p)
		}
	}
	return out
}

func initCFRanges() {
	type cfResult struct {
		Result struct {
			IPv4 []string `json:"ipv4_cidrs"`
			IPv6 []string `json:"ipv6_cidrs"`
		} `json:"result"`
		Success bool `json:"success"`
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get("https://api.cloudflare.com/client/v4/ips")
	if err != nil {
		log.Printf("cfRanges: fetch failed, using fallback: %v", err)
		cfRanges = parsePrefixes(cfRangesFallback)
		return
	}
	defer resp.Body.Close()

	var result cfResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil || !result.Success {
		log.Printf("cfRanges: decode failed, using fallback: %v", err)
		cfRanges = parsePrefixes(cfRangesFallback)
		return
	}

	all := append(result.Result.IPv4, result.Result.IPv6...)
	cfRanges = parsePrefixes(all)
	log.Printf("cfRanges: loaded %d prefixes from API", len(cfRanges))
}

func isCloudflare(ip string) bool {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return false
	}
	for _, p := range cfRanges {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

func IsLoopback(ip string) bool {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return false
	}
	return addr.IsLoopback()
}

func ClientIP(c fiber.Ctx) string {
	connIP := c.IP()
	// CF-Connecting-IP is trusted when:
	//   - direct from Cloudflare edge (connIP is a CF range)
	//   - via Caddy on localhost (Caddy forwards the header untouched)
	if isCloudflare(connIP) || IsLoopback(connIP) {
		if ip := c.Get("CF-Connecting-IP"); ip != "" {
			return ip
		}
	}
	// Caddy without Cloudflare: fall back to X-Forwarded-For
	if IsLoopback(connIP) {
		if ip := c.Get("X-Forwarded-For"); ip != "" {
			return ip
		}
	}
	return connIP
}

func Middleware(c fiber.Ctx) error {
	if !enableLogging && (!isTerminal || c.Get("CF-Connecting-IP") != "" || c.Get("X-Forwarded-For") != "") {
		return c.Next()
	}

	start := time.Now()
	chain := c.Next()

	elapsed := time.Since(start)
	ip := ClientIP(c)
	host, hostFiltered := sanitizeLogValue(c.Hostname())
	method := c.Method()
	path, pathFiltered := sanitizeLogValue(c.Path())
	status := c.Response().StatusCode()
	ua, uaFiltered := sanitizeLogValue(c.Get(fiber.HeaderUserAgent))
	host, hostTruncated := truncateLogValue(host, 96)
	path, pathTruncated := truncateLogValue(path, 240)
	ua, uaTruncated := truncateLogValue(ua, 256)
	hostFiltered = hostFiltered || hostTruncated
	pathFiltered = pathFiltered || pathTruncated
	uaFiltered = uaFiltered || uaTruncated

	stCol := "\033[32m"
	if status >= 300 {
		stCol = "\033[36m"
	}
	if status >= 400 {
		stCol = "\033[31m"
	}

	var buf [768]byte
	b := buf[:0]
	b = append(b, "\n\033[32mINFO\033[0m:\t\033[33m"...)
	b = append(b, host...)
	if hostFiltered {
		b = append(b, " (filtered)"...)
	}
	b = append(b, "\033[0m:\t\033[34m"...)
	b = append(b, ip...)
	b = append(b, "\033[0m: "...)
	b = append(b, stCol...)
	b = strconv.AppendInt(b, int64(status), 10)
	b = append(b, "\033[0m: \033[35m"...)
	b = append(b, method...)
	b = append(b, "\033[36m "...)
	b = append(b, path...)
	if pathFiltered {
		b = append(b, " (filtered)"...)
	}
	b = append(b, "\nUser-Agent: \033[0m"...)
	b = append(b, ua...)
	if uaFiltered {
		b = append(b, " (filtered)"...)
	}
	b = append(b, "\t\033[39m"...)
	b = append(b, elapsed.String()...)
	b = append(b, "\033[0m\n"...)
	_, _ = os.Stdout.Write(b)

	return chain
}

func sanitizeLogValue(v string) (string, bool) {
	if v == "" {
		return "", false
	}

	var b strings.Builder
	b.Grow(len(v))
	filtered := false
	for _, r := range v {
		switch {
		case r == '\n' || r == '\r' || r == '\t':
			b.WriteByte(' ')
			filtered = true
		case r == 0x1b:
			filtered = true
		case r == '"':
			b.WriteByte('\'')
			filtered = true
		case r < 0x20 || r == 0x7f:
			filtered = true
		default:
			b.WriteRune(r)
		}
	}
	return b.String(), filtered
}

func truncateLogValue(v string, maxRunes int) (string, bool) {
	if maxRunes <= 0 {
		return "", v != ""
	}
	runes := []rune(v)
	if len(runes) <= maxRunes {
		return v, false
	}
	if maxRunes <= 3 {
		return string(runes[:maxRunes]), true
	}
	return string(runes[:maxRunes-3]) + "...", true
}
