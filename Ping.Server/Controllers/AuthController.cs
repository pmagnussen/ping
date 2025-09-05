using Microsoft.AspNetCore.Mvc;
using Ping.Server.Services;

namespace Ping.Server.Controllers
{
    [Route("auth")] // Add this line
    public class AuthController : Controller
    {
        private readonly ILogger<AuthController> _logger;
        private readonly IOidcService _oidcService;

        public AuthController(ILogger<AuthController> logger, IOidcService oidcService)
        {
            _logger = logger;
            _oidcService = oidcService;
        }

        // === WEB UI ENDPOINTS (6-digit code flow) ===

        [HttpGet("signin")]
        public IActionResult SignIn([FromQuery] string? returnUrl = null)
        {
            ViewBag.ReturnUrl = returnUrl;
            return View();
        }

        [HttpPost("signin")]
        public async Task<IActionResult> SignIn([FromForm] SignInRequest request)
        {
            // Use returnUrl from form model or query string
            var actualReturnUrl = request.ReturnUrl;

            if (!ModelState.IsValid)
            {
                ViewBag.ReturnUrl = actualReturnUrl;
                return View(request);
            }

            if (string.IsNullOrWhiteSpace(request.Email))
            {
                ModelState.AddModelError("Email", "Email is required");
                ViewBag.ReturnUrl = actualReturnUrl;
                return View(request);
            }

            if (!IsValidEmail(request.Email))
            {
                ModelState.AddModelError("Email", "Invalid email format");
                ViewBag.ReturnUrl = actualReturnUrl;
                return View(request);
            }

            _logger.LogInformation("Verification code requested for email: {Email}", request.Email);

            // Generate 6-digit verification code
            var verificationCode = await _oidcService.CreateVerificationCodeAsync(request.Email);

            // TODO: Send email with 6-digit code
            _logger.LogInformation("Verification code generated for {Email}: {Code}", request.Email, verificationCode.Code);

            await Task.Delay(500); // Simulate email sending

            // Redirect to code verification page
            return RedirectToAction("VerifyCode", new { email = request.Email, returnUrl = actualReturnUrl });
        }

        [HttpGet("verify-code")]
        public IActionResult VerifyCode([FromQuery] string email, [FromQuery] string? returnUrl = null)
        {
            if (string.IsNullOrWhiteSpace(email))
            {
                return RedirectToAction("SignIn", new { returnUrl });
            }

            return View(new VerifyCodeViewModel { Email = email, ReturnUrl = returnUrl });
        }

        [HttpPost("verify-code")]
        public async Task<IActionResult> VerifyCode([FromForm] VerifyCodeRequest request, [FromQuery] string? returnUrl = null)
        {
            if (!ModelState.IsValid)
            {
                return View(new VerifyCodeViewModel { Email = request.Email, ReturnUrl = returnUrl });
            }

            if (string.IsNullOrWhiteSpace(request.Email) || string.IsNullOrWhiteSpace(request.Code))
            {
                ModelState.AddModelError("", "Email and verification code are required");
                return View(new VerifyCodeViewModel { Email = request.Email, ReturnUrl = returnUrl });
            }

            // Validate the 6-digit code
            var user = await _oidcService.ValidateVerificationCodeAsync(request.Email, request.Code);
            if (user == null)
            {
                ModelState.AddModelError("Code", "Invalid or expired verification code");
                return View(new VerifyCodeViewModel { Email = request.Email, ReturnUrl = returnUrl });
            }

            _logger.LogInformation("Verification code validated for email: {Email}", user.Email);

            // Generate temporary token for JWT exchange
            var tempToken = Guid.NewGuid().ToString("N")[..16];

            // TODO: Store tempToken temporarily with user association
            // For now, we'll use the user ID as the token

            // Redirect to token exchange page
            return View("TokenExchange", new TokenExchangeViewModel 
            { 
                Email = user.Email, 
                MagicToken = user.Id, // Use user ID as temp token
                ReturnUrl = returnUrl 
            });
        }

        [HttpGet("emailsent")]
        public IActionResult EmailSent([FromQuery] string email, [FromQuery] string? returnUrl = null)
        {
            if (string.IsNullOrWhiteSpace(email))
            {
                return RedirectToAction("SignIn", new { returnUrl });
            }
            return View(new EmailSentViewModel { Email = email, ReturnUrl = returnUrl });
        }

        [HttpGet("success")]
        public IActionResult Success([FromQuery] string email)
        {
            if (string.IsNullOrEmpty(email))
            {
                return RedirectToAction("SignIn");
            }
            return View(new SuccessViewModel { Email = email });
        }

        [HttpGet("signout")]
        public IActionResult SignOut()
        {
            return RedirectToAction("SignIn");
        }

        // === API ENDPOINTS (for mobile/API clients) ===

        [HttpPost("api/request-code")]
        public async Task<IActionResult> RequestCodeApi([FromBody] RequestCodeApiRequest request)
        {
            if (string.IsNullOrWhiteSpace(request.Email))
            {
                return BadRequest(new { message = "Email is required" });
            }

            if (!IsValidEmail(request.Email))
            {
                return BadRequest(new { message = "Invalid email format" });
            }

            _logger.LogInformation("API verification code requested for email: {Email}", request.Email);

            var verificationCode = await _oidcService.CreateVerificationCodeAsync(request.Email);

            // TODO: Send email with 6-digit code
            _logger.LogInformation("API verification code generated for {Email}: {Code}", request.Email, verificationCode.Code);

            await Task.Delay(500);

            return Ok(new RequestCodeApiResponse
            {
                Success = true,
                Message = "Verification code sent to your email",
                Email = request.Email,
                ExpiresInMinutes = 10
            });
        }

        [HttpPost("api/verify-code")]
        public async Task<IActionResult> VerifyCodeApi([FromBody] VerifyCodeApiRequest request)
        {
            if (string.IsNullOrWhiteSpace(request.Email) || string.IsNullOrWhiteSpace(request.Code))
            {
                return BadRequest(new { message = "Email and code are required" });
            }

            var user = await _oidcService.ValidateVerificationCodeAsync(request.Email, request.Code);
            if (user == null)
            {
                return BadRequest(new { message = "Invalid or expired verification code" });
            }

            _logger.LogInformation("API verification code validated for email: {Email}", user.Email);

            return Ok(new VerifyCodeApiResponse
            {
                Success = true,
                UserId = user.Id,
                Email = user.Email,
                Name = user.Name,
                TempToken = user.Id, // Temporary token for OIDC exchange
                Message = "Verification code validated successfully"
            });
        }

        // Keep legacy magic link endpoints for backward compatibility
        [HttpGet("verify")]
        public async Task<IActionResult> VerifyMagicLink([FromQuery] string token, [FromQuery] string? returnUrl = null)
        {
            if (string.IsNullOrWhiteSpace(token))
            {
                return View("VerifyError", new VerifyErrorViewModel 
                { 
                    Message = "Invalid or expired magic link. Please try signing in again.",
                    ReturnUrl = returnUrl
                });
            }

            var user = await _oidcService.ValidateMagicLinkAsync(token);
            if (user == null)
            {
                return View("VerifyError", new VerifyErrorViewModel 
                { 
                    Message = "Invalid or expired magic link. Please try signing in again.",
                    ReturnUrl = returnUrl
                });
            }

            _logger.LogInformation("Magic link verification successful for email: {Email}", user.Email);

            return View("TokenExchange", new TokenExchangeViewModel 
            { 
                Email = user.Email, 
                MagicToken = token,
                ReturnUrl = returnUrl 
            });
        }

        private static bool IsValidEmail(string email)
        {
            try
            {
                var addr = new System.Net.Mail.MailAddress(email);
                return addr.Address == email;
            }
            catch
            {
                return false;
            }
        }
    }

    // === MODELS ===

    public class SignInRequest
    {
        public string Email { get; set; } = string.Empty;
        public string? ReturnUrl { get; set; } // Add this property
    }

    public class VerifyCodeViewModel
    {
        public string Email { get; set; } = string.Empty;
        public string? ReturnUrl { get; set; }
    }

    public class VerifyCodeRequest
    {
        public string Email { get; set; } = string.Empty;
        public string Code { get; set; } = string.Empty;
    }

    public class EmailSentViewModel
    {
        public string Email { get; set; } = string.Empty;
        public string? ReturnUrl { get; set; }
    }

    public class VerifyErrorViewModel
    {
        public string Message { get; set; } = string.Empty;
        public string? ReturnUrl { get; set; }
    }

    public class SuccessViewModel
    {
        public string Email { get; set; } = string.Empty;
    }

    public class TokenExchangeViewModel
    {
        public string Email { get; set; } = string.Empty;
        public string MagicToken { get; set; } = string.Empty;
        public string? ReturnUrl { get; set; }
    }

    // API Models
    public class RequestCodeApiRequest
    {
        public string Email { get; set; } = string.Empty;
    }

    public class RequestCodeApiResponse
    {
        public bool Success { get; set; }
        public string Message { get; set; } = string.Empty;
        public string Email { get; set; } = string.Empty;
        public int ExpiresInMinutes { get; set; }
    }

    public class VerifyCodeApiRequest
    {
        public string Email { get; set; } = string.Empty;
        public string Code { get; set; } = string.Empty;
    }

    public class VerifyCodeApiResponse
    {
        public bool Success { get; set; }
        public string UserId { get; set; } = string.Empty;
        public string Email { get; set; } = string.Empty;
        public string Name { get; set; } = string.Empty;
        public string TempToken { get; set; } = string.Empty;
        public string Message { get; set; } = string.Empty;
    }
}
