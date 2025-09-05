using Microsoft.IdentityModel.Tokens;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;

namespace Ping.Server.Services
{
    public interface IJwtService
    {
        string GenerateToken(string email, string userId);
        ClaimsPrincipal? ValidateToken(string token);
        string GenerateMagicLinkToken(string email);
        string? ValidateMagicLinkToken(string token);
    }

    public class JwtService : IJwtService
    {
        private readonly string _secretKey;
        private readonly string _issuer;
        private readonly string _audience;
        private readonly ILogger<JwtService> _logger;

        public JwtService(IConfiguration configuration, ILogger<JwtService> logger)
        {
            _secretKey = configuration["Jwt:SecretKey"] ?? "your-256-bit-secret-key-here-make-it-long-enough-for-security";
            _issuer = configuration["Jwt:Issuer"] ?? "ping.vera.fo";
            _audience = configuration["Jwt:Audience"] ?? "ping.vera.fo";
            _logger = logger;
        }

        public string GenerateToken(string email, string userId)
        {
            var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_secretKey));
            var credentials = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

            var claims = new[]
            {
                new Claim(ClaimTypes.Email, email),
                new Claim(ClaimTypes.NameIdentifier, userId),
                new Claim("sub", userId),
                new Claim("email", email),
                new Claim("iat", DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(), ClaimValueTypes.Integer64),
                new Claim(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString())
            };

            var token = new JwtSecurityToken(
                issuer: _issuer,
                audience: _audience,
                claims: claims,
                expires: DateTime.UtcNow.AddDays(30), // Long-lived token
                signingCredentials: credentials
            );

            return new JwtSecurityTokenHandler().WriteToken(token);
        }

        public ClaimsPrincipal? ValidateToken(string token)
        {
            try
            {
                var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_secretKey));
                var tokenHandler = new JwtSecurityTokenHandler();

                var validationParameters = new TokenValidationParameters
                {
                    ValidateIssuerSigningKey = true,
                    IssuerSigningKey = key,
                    ValidateIssuer = true,
                    ValidIssuer = _issuer,
                    ValidateAudience = true,
                    ValidAudience = _audience,
                    ValidateLifetime = true,
                    ClockSkew = TimeSpan.FromMinutes(5)
                };

                var principal = tokenHandler.ValidateToken(token, validationParameters, out SecurityToken validatedToken);
                return principal;
            }
            catch (Exception ex)
            {
                _logger.LogWarning("Token validation failed: {Error}", ex.Message);
                return null;
            }
        }

        public string GenerateMagicLinkToken(string email)
        {
            var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_secretKey));
            var credentials = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

            var claims = new[]
            {
                new Claim("email", email),
                new Claim("type", "magic_link"),
                new Claim("iat", DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(), ClaimValueTypes.Integer64)
            };

            var token = new JwtSecurityToken(
                issuer: _issuer,
                audience: _audience,
                claims: claims,
                expires: DateTime.UtcNow.AddMinutes(15), // Short-lived magic link token
                signingCredentials: credentials
            );

            return new JwtSecurityTokenHandler().WriteToken(token);
        }

        public string? ValidateMagicLinkToken(string token)
        {
            try
            {
                var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_secretKey));
                var tokenHandler = new JwtSecurityTokenHandler();

                var validationParameters = new TokenValidationParameters
                {
                    ValidateIssuerSigningKey = true,
                    IssuerSigningKey = key,
                    ValidateIssuer = true,
                    ValidIssuer = _issuer,
                    ValidateAudience = true,
                    ValidAudience = _audience,
                    ValidateLifetime = true,
                    ClockSkew = TimeSpan.FromMinutes(1)
                };

                var principal = tokenHandler.ValidateToken(token, validationParameters, out SecurityToken validatedToken);
                var emailClaim = principal.FindFirst("email")?.Value;
                var typeClaim = principal.FindFirst("type")?.Value;

                if (typeClaim != "magic_link")
                {
                    _logger.LogWarning("Invalid token type: {Type}", typeClaim);
                    return null;
                }

                return emailClaim;
            }
            catch (Exception ex)
            {
                _logger.LogWarning("Magic link token validation failed: {Error}", ex.Message);
                return null;
            }
        }
    }
}
