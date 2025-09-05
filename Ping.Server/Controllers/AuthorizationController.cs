using Microsoft.AspNetCore;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.IdentityModel.Tokens;
using OpenIddict.Abstractions;
using OpenIddict.Server.AspNetCore;
using Ping.Server.Models;
using Ping.Server.Services;
using System.Security.Claims;
using static OpenIddict.Abstractions.OpenIddictConstants;

namespace Ping.Server.Controllers
{
    public class AuthorizationController : Controller
    {
        private readonly IOpenIddictApplicationManager _applicationManager;
        private readonly IOidcService _oidcService;
        private readonly IUserService _userService;
        private readonly ILogger<AuthorizationController> _logger;

        public AuthorizationController(
            IOpenIddictApplicationManager applicationManager,
            IOidcService oidcService,
            IUserService userService,
            ILogger<AuthorizationController> logger)
        {
            _applicationManager = applicationManager;
            _oidcService = oidcService;
            _userService = userService;
            _logger = logger;
        }

        [HttpGet("~/connect/authorize")]
        [HttpPost("~/connect/authorize")]
        [IgnoreAntiforgeryToken]
        public async Task<IActionResult> Authorize()
        {
            var request = HttpContext.GetOpenIddictServerRequest() ??
                throw new InvalidOperationException("The OpenID Connect request cannot be retrieved.");

            // Check for magic link token in request parameters (for direct JWT flow)
            if (request.HasParameter("magic_token"))
            {
                return await HandleMagicLinkAuthorization(request);
            }

            // For traditional OIDC flow, redirect to 6-digit code sign-in
            return RedirectToAction("SignIn", "Auth", new
            {
                returnUrl = Request.PathBase + Request.Path + QueryString.Create(
                    Request.HasFormContentType ? Request.Form.ToList() : Request.Query.ToList())
            });
        }

        private async Task<IActionResult> HandleMagicLinkAuthorization(OpenIddictRequest request)
        {
            var magicToken = request.GetParameter("magic_token")?.ToString();
            if (string.IsNullOrEmpty(magicToken))
            {
                return BadRequest("Magic token is required");
            }

            // First try to validate as user ID (from 6-digit code flow)
            ApplicationUser? user = null;

            // Check if this is a user ID from the verification code flow
            user = await _userService.GetUserByIdAsync(magicToken);

            // If not found by ID, try validating as a legacy magic link token
            if (user == null)
            {
                user = await _oidcService.ValidateMagicLinkAsync(magicToken);
            }

            if (user == null)
            {
                return BadRequest("Invalid or expired magic token");
            }

            _logger.LogInformation("Magic token authorization successful for email: {Email}", user.Email);

            // Create claims identity
            var identity = new ClaimsIdentity(
                authenticationType: TokenValidationParameters.DefaultAuthenticationType,
                nameType: Claims.Name,
                roleType: Claims.Role);

            // ✅ Add user claims ONCE
            identity.AddClaim(new Claim(Claims.Subject, user.Id));
            identity.AddClaim(new Claim(Claims.Email, user.Email));
            identity.AddClaim(new Claim(Claims.Name, user.Name));
            identity.AddClaim(new Claim(Claims.PreferredUsername, user.Email));
            identity.AddClaim(new Claim(Claims.Role, user.Role.ToString()));

            // ✅ Add permissions as claims
            foreach (var permission in user.Permissions)
            {
                identity.AddClaim(new Claim("permission", permission));
            }

            // ✅ Also add permissions from UserPermissions navigation property
            foreach (var userPermission in user.UserPermissions)
            {
                if (!user.Permissions.Contains(userPermission.Permission))
                {
                    identity.AddClaim(new Claim("permission", userPermission.Permission));
                }
            }

            // Set requested scopes
            identity.SetScopes(request.GetScopes());
            identity.SetResources(await GetResourcesAsync(request.GetScopes()));

            // Set destinations for claims
            foreach (var claim in identity.Claims)
            {
                claim.SetDestinations(GetDestinations(claim, identity));
            }

            var principal = new ClaimsPrincipal(identity);
            return SignIn(principal, OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
        }

        [HttpPost("~/connect/token")]
        [IgnoreAntiforgeryToken]
        public async Task<IActionResult> Exchange()
        {
            var request = HttpContext.GetOpenIddictServerRequest() ??
                throw new InvalidOperationException("The OpenID Connect request cannot be retrieved.");

            // Handle client credentials flow with magic token
            if (request.IsClientCredentialsGrantType() && request.HasParameter("magic_token"))
            {
                return await HandleMagicTokenClientCredentials(request);
            }

            // Handle standard flows
            if (request.IsAuthorizationCodeGrantType() || request.IsRefreshTokenGrantType())
            {
                return SignIn(HttpContext.User, OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
            }

            // Handle standard client credentials
            if (request.IsClientCredentialsGrantType())
            {
                var application = await _applicationManager.FindByClientIdAsync(request.ClientId!);
                if (application == null)
                {
                    return BadRequest("Invalid client");
                }

                var identity = new ClaimsIdentity(TokenValidationParameters.DefaultAuthenticationType);
                identity.AddClaim(new Claim(Claims.Subject, await _applicationManager.GetClientIdAsync(application)));
                identity.SetScopes(request.GetScopes());
                identity.SetResources(await GetResourcesAsync(request.GetScopes()));

                var principal = new ClaimsPrincipal(identity);
                return SignIn(principal, OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
            }

            throw new InvalidOperationException("The specified grant type is not supported.");
        }

        private async Task<IActionResult> HandleMagicTokenClientCredentials(OpenIddictRequest request)
        {
            var magicToken = request.GetParameter("magic_token")?.ToString();
            if (string.IsNullOrEmpty(magicToken))
            {
                return BadRequest("Magic token is required");
            }

            // First try to validate as user ID (from 6-digit code flow)
            ApplicationUser? user = null;

            // Check if this is a user ID from the verification code flow
            user = await _userService.GetUserByIdAsync(magicToken);

            // If not found by ID, try validating as a legacy magic link token
            if (user == null)
            {
                user = await _oidcService.ValidateMagicLinkAsync(magicToken);
            }

            if (user == null)
            {
                return BadRequest("Invalid or expired magic token");
            }

            _logger.LogInformation("Client credentials with magic token successful for email: {Email}", user.Email);

            // Create user-specific identity for client credentials flow
            var identity = new ClaimsIdentity(TokenValidationParameters.DefaultAuthenticationType);

            // Add claims individually (AddClaim returns void, so no chaining)
            identity.AddClaim(new Claim(Claims.Subject, user.Id));
            identity.AddClaim(new Claim(Claims.Email, user.Email));
            identity.AddClaim(new Claim(Claims.Name, user.Name));
            identity.AddClaim(new Claim(Claims.PreferredUsername, user.Email));
            identity.AddClaim(new Claim(Claims.Role, user.Role.ToString()));

            // Add permissions as claims
            foreach (var permission in user.Permissions)
            {
                identity.AddClaim(new Claim("permission", permission));
            }

            // Also add permissions from UserPermissions navigation property
            foreach (var userPermission in user.UserPermissions)
            {
                if (!user.Permissions.Contains(userPermission.Permission))
                {
                    identity.AddClaim(new Claim("permission", userPermission.Permission));
                }
            }

            identity.SetScopes(request.GetScopes());
            identity.SetResources(await GetResourcesAsync(request.GetScopes()));

            // Set destinations for claims
            foreach (var claim in identity.Claims)
            {
                claim.SetDestinations(GetDestinations(claim, identity));
            }

            var principal = new ClaimsPrincipal(identity);
            return SignIn(principal, OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
        }

        [Authorize(AuthenticationSchemes = OpenIddict.Validation.AspNetCore.OpenIddictValidationAspNetCoreDefaults.AuthenticationScheme)] // ✅ Keep this - userinfo needs validation
        [HttpGet("~/connect/userinfo")]
        public async Task<IActionResult> Userinfo()
        {
            var user = HttpContext.User;

            // Get user permissions from claims
            var permissions = user.FindAll("permission").Select(c => c.Value).ToArray();

            return Ok(new
            {
                sub = user.GetClaim(Claims.Subject),
                email = user.GetClaim(Claims.Email),
                name = user.GetClaim(Claims.Name),
                preferred_username = user.GetClaim(Claims.PreferredUsername),
                role = user.GetClaim(Claims.Role),
                permissions = permissions
            });
        }

        [HttpGet("~/connect/logout")]
        public IActionResult Logout()
        {
            // JWT logout - just return success (client should discard tokens)
            return Ok(new { message = "Logged out successfully" });
        }

        private async Task<IEnumerable<string>> GetResourcesAsync(IEnumerable<string> scopes)
        {
            return scopes;
        }

        private static IEnumerable<string> GetDestinations(Claim claim, ClaimsIdentity identity)
        {
            switch (claim.Type)
            {
                case Claims.Name:
                case Claims.PreferredUsername:
                    yield return Destinations.AccessToken;
                    if (identity.HasScope(Scopes.Profile))
                        yield return Destinations.IdentityToken;
                    yield break;

                case Claims.Email:
                    yield return Destinations.AccessToken;
                    if (identity.HasScope(Scopes.Email))
                        yield return Destinations.IdentityToken;
                    yield break;

                case Claims.Role:
                case "permission":
                    yield return Destinations.AccessToken;
                    if (identity.HasScope(Scopes.Roles))
                        yield return Destinations.IdentityToken;
                    yield break;

                case Claims.Subject:
                    yield return Destinations.AccessToken;
                    yield return Destinations.IdentityToken;
                    yield break;

                default:
                    yield return Destinations.AccessToken;
                    yield break;
            }
        }
    }
}