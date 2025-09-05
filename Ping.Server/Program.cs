using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Ping.Server.Data;
using Ping.Server.Hubs;
using Ping.Server.Models;
using Ping.Server.Services;
using System.Text;
using static OpenIddict.Abstractions.OpenIddictConstants;

var builder = WebApplication.CreateBuilder(args);

// Database
builder.Services.AddDbContext<ApplicationDbContext>(options =>
{
    options.UseInMemoryDatabase("PingDb"); // Use SQL Server/PostgreSQL in production
    options.UseOpenIddict();
});

// Services
builder.Services.AddScoped<IOidcService, OidcService>();
// Add User Service
builder.Services.AddScoped<IUserService, UserService>();

// MVC/Swagger
builder.Services.AddControllersWithViews();
builder.Services.AddRazorPages();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

// OpenIddict - Server + Validation in same app
builder.Services.AddOpenIddict()
    .AddCore(options =>
    {
        options.UseEntityFrameworkCore()
               .UseDbContext<ApplicationDbContext>();
    })
    .AddServer(options =>
    {
        // 🎯 Set explicit issuer to match your server port
        options.SetIssuer(new Uri("https://localhost:7160"));

        // Enable the authorization, logout, token and userinfo endpoints
        options.SetAuthorizationEndpointUris("/connect/authorize")
               .SetLogoutEndpointUris("/connect/logout")
               .SetTokenEndpointUris("/connect/token")
               .SetUserinfoEndpointUris("/connect/userinfo");

        // Register all scopes globally
        options.RegisterScopes(Scopes.OpenId, Scopes.Email, Scopes.Profile, Scopes.Roles, "ping-api");

        // Enable the authorization code flow
        options.AllowAuthorizationCodeFlow()
               .AllowRefreshTokenFlow()
               .AllowClientCredentialsFlow();

        // Register the signing and encryption credentials
        if (builder.Environment.IsDevelopment())
        {
            options.AddDevelopmentEncryptionCertificate()
                   .AddDevelopmentSigningCertificate();
        }
        else
        {
            options.AddDevelopmentEncryptionCertificate()
                   .AddDevelopmentSigningCertificate();
        }

        // Register the ASP.NET Core host and configure the ASP.NET Core-specific options
        options.UseAspNetCore()
               .EnableAuthorizationEndpointPassthrough()
               .EnableLogoutEndpointPassthrough()
               .EnableTokenEndpointPassthrough()
               .EnableUserinfoEndpointPassthrough()
               .EnableStatusCodePagesIntegration();

        // Disable token encryption and use signed tokens instead
        options.DisableAccessTokenEncryption();
    })
    .AddValidation(options =>
    {
        // 🎯 Use the same issuer for validation
        options.SetIssuer(new Uri("https://localhost:7160"));
        options.UseLocalServer();
        options.UseAspNetCore();
    });

// Simple authentication setup
builder.Services.AddAuthentication(options =>
{
    options.DefaultScheme = OpenIddict.Validation.AspNetCore.OpenIddictValidationAspNetCoreDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = OpenIddict.Validation.AspNetCore.OpenIddictValidationAspNetCoreDefaults.AuthenticationScheme;
});

// Configure SignalR with custom authentication
builder.Services.AddSignalR(options =>
{
    options.EnableDetailedErrors = true;
    options.MaximumReceiveMessageSize = 2 * 1024 * 1024;
})
.AddMessagePackProtocol();

// CORS (dev + prod) - Updated to allow OIDC origins
builder.Services.AddCors(o =>
{
    o.AddPolicy("dev", p => p
        .WithOrigins("https://localhost:51520", "https://localhost:7160")
        .AllowAnyHeader().AllowAnyMethod().AllowCredentials());

    o.AddPolicy("prod", p => p
        .WithOrigins("https://ping.vera.fo")
        .AllowAnyHeader().AllowAnyMethod().AllowCredentials());
});

builder.Services.Configure<Microsoft.AspNetCore.Authentication.AuthenticationOptions>(options =>
{
    options.DefaultAuthenticateScheme = OpenIddict.Validation.AspNetCore.OpenIddictValidationAspNetCoreDefaults.AuthenticationScheme;
});

var app = builder.Build();

// Seed both OIDC clients and users
await SeedOpenIddictClients(app.Services);
await SeedUsers(app.Services);

if (!app.Environment.IsDevelopment()) app.UseHsts();
if (app.Environment.IsDevelopment()) { app.UseSwagger(); app.UseSwaggerUI(); }

// IMPORTANT: respect proxy headers before redirects
var fwd = new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto
};
fwd.KnownNetworks.Clear();
fwd.KnownProxies.Clear();
app.UseForwardedHeaders(fwd);

app.UseHttpsRedirection();
app.UseStaticFiles();
app.UseRouting();

app.UseCors();

// Authentication & Authorization
app.UseAuthentication();
app.UseAuthorization();

app.MapRazorPages();
app.MapControllers();

// Move this BEFORE the hub mapping
app.Use(async (context, next) =>
{
    if (context.Request.Path.StartsWithSegments("/voice") &&
        context.Request.Query.TryGetValue("access_token", out var token))
    {
        context.Request.Headers["Authorization"] = $"Bearer {token}";
    }
    await next();
});

var corsPolicy = app.Environment.IsDevelopment() ? "dev" : "prod";
app.MapHub<AudioHub>("/voice").RequireCors(corsPolicy).RequireAuthorization();

app.Run();

// Seed OIDC clients - Updated for JWT-only flow
static async Task SeedOpenIddictClients(IServiceProvider services)
{
    using var scope = services.CreateScope();
    var context = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
    await context.Database.EnsureCreatedAsync();

    var manager = scope.ServiceProvider.GetRequiredService<OpenIddict.Abstractions.IOpenIddictApplicationManager>();

    // API Resource for JWT validation
    if (await manager.FindByClientIdAsync("ping-api") is null)
    {
        await manager.CreateAsync(new OpenIddict.Abstractions.OpenIddictApplicationDescriptor
        {
            ClientId = "ping-api",
            ClientSecret = "ping-api-secret",
            DisplayName = "Ping API",
            ClientType = ClientTypes.Confidential,
            Permissions =
            {
                Permissions.Endpoints.Introspection,
                Permissions.GrantTypes.ClientCredentials
            }
        });
    }

    // Ping Voice Chat Web Client - Updated for JWT
    if (await manager.FindByClientIdAsync("ping-voice-chat") is null)
    {
        await manager.CreateAsync(new OpenIddict.Abstractions.OpenIddictApplicationDescriptor
        {
            ClientId = "ping-voice-chat",
            ClientSecret = "ping-voice-chat-secret",
            ConsentType = ConsentTypes.Implicit,
            DisplayName = "Ping Voice Chat",
            ClientType = ClientTypes.Confidential,
            PostLogoutRedirectUris =
            {
                new Uri("https://localhost:51520/"),
                new Uri("https://ping.vera.fo/")
            },
            RedirectUris =
            {
                new Uri("https://localhost:51520/auth/callback"),
                new Uri("https://ping.vera.fo/auth/callback")
            },
            Permissions =
            {
                Permissions.Endpoints.Authorization,
                Permissions.Endpoints.Logout,
                Permissions.Endpoints.Token,
                Permissions.Endpoints.Introspection,
                Permissions.GrantTypes.AuthorizationCode,
                Permissions.GrantTypes.RefreshToken,
                Permissions.GrantTypes.ClientCredentials,
                Permissions.ResponseTypes.Code,
                Permissions.Prefixes.Scope + "openid",        // 🎯 Fix this
                Permissions.Scopes.Email,
                Permissions.Scopes.Profile,
                Permissions.Scopes.Roles,
                Permissions.Prefixes.Scope + "ping-api"       // 🎯 Fix this
            },
            Requirements =
            {
                Requirements.Features.ProofKeyForCodeExchange
            }
        });
    }

    // Mobile clients remain the same but now get JWT tokens
    if (await manager.FindByClientIdAsync("ping-ios-app") is null)
    {
        await manager.CreateAsync(new OpenIddict.Abstractions.OpenIddictApplicationDescriptor
        {
            ClientId = "ping-ios-app",
            ClientSecret = "ping-ios-secure-secret-2024",
            ConsentType = ConsentTypes.Implicit,
            DisplayName = "Ping iOS App",
            ClientType = ClientTypes.Confidential,
            PostLogoutRedirectUris =
            {
                new Uri("pingapp://logout"),
            },
            RedirectUris =
            {
                new Uri("pingapp://auth/callback"),
            },
            Permissions =
            {
                Permissions.Endpoints.Authorization,
                Permissions.Endpoints.Logout,
                Permissions.Endpoints.Token,
                Permissions.Endpoints.Introspection,
                Permissions.GrantTypes.AuthorizationCode,
                Permissions.GrantTypes.RefreshToken,
                Permissions.GrantTypes.ClientCredentials,
                Permissions.ResponseTypes.Code,
                Permissions.Scopes.Email,
                Permissions.Scopes.Profile,
                "ping-api"
            },
            Requirements =
            {
                Requirements.Features.ProofKeyForCodeExchange
            }
        });
    }

    if (await manager.FindByClientIdAsync("ping-android-app") is null)
    {
        await manager.CreateAsync(new OpenIddict.Abstractions.OpenIddictApplicationDescriptor
        {
            ClientId = "ping-android-app",
            ClientSecret = "ping-android-secure-secret-2024",
            ConsentType = ConsentTypes.Implicit,
            DisplayName = "Ping Android App",
            ClientType = ClientTypes.Confidential,
            PostLogoutRedirectUris =
            {
                new Uri("com.ping.app://logout"),
            },
            RedirectUris =
            {
                new Uri("com.ping.app://auth/callback"),
            },
            Permissions =
            {
                Permissions.Endpoints.Authorization,
                Permissions.Endpoints.Logout,
                Permissions.Endpoints.Token,
                Permissions.Endpoints.Introspection,
                Permissions.GrantTypes.AuthorizationCode,
                Permissions.GrantTypes.RefreshToken,
                Permissions.GrantTypes.ClientCredentials,
                Permissions.ResponseTypes.Code,
                Permissions.Scopes.Email,
                Permissions.Scopes.Profile,
                "ping-api"
            },
            Requirements =
            {
                Requirements.Features.ProofKeyForCodeExchange
            }
        });
    }

    // External application
    if (await manager.FindByClientIdAsync("external-app") is null)
    {
        await manager.CreateAsync(new OpenIddict.Abstractions.OpenIddictApplicationDescriptor
        {
            ClientId = "external-app",
            ClientSecret = "external-app-secret",
            ConsentType = ConsentTypes.Explicit,
            DisplayName = "External Application",
            ClientType = ClientTypes.Confidential,
            PostLogoutRedirectUris =
            {
                new Uri("https://external-app.example.com/"),
            },
            RedirectUris =
            {
                new Uri("https://external-app.example.com/auth/callback"),
            },
            Permissions =
            {
                Permissions.Endpoints.Authorization,
                Permissions.Endpoints.Logout,
                Permissions.Endpoints.Token,
                Permissions.GrantTypes.AuthorizationCode,
                Permissions.GrantTypes.RefreshToken,
                Permissions.ResponseTypes.Code,
                Permissions.Scopes.Email,
                Permissions.Scopes.Profile,
                "ping-api"
            },
            Requirements =
            {
                Requirements.Features.ProofKeyForCodeExchange
            }
        });
    }
}

// Add user seeding
static async Task SeedUsers(IServiceProvider services)
{
    using var scope = services.CreateScope();
    var userService = scope.ServiceProvider.GetRequiredService<IUserService>();
    var context = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
    
    await context.Database.EnsureCreatedAsync();

    // Seed initial users - add your allowed users here
    var initialUsers = new[]
    {
        new { Email = "admin@ping.vera.fo", Name = "Admin User", Role = UserRole.SuperAdmin },
        new { Email = "moderator@ping.vera.fo", Name = "Moderator", Role = UserRole.Moderator },
        new { Email = "user@ping.vera.fo", Name = "Regular User", Role = UserRole.User },
        // Add more users as needed
        new { Email = "paetur.magnussen@gmail.com", Name = "Pætur Magnussen", Role = UserRole.Admin }
    };

    foreach (var userData in initialUsers)
    {
        var existingUser = await userService.GetUserByEmailAsync(userData.Email);
        if (existingUser == null)
        {
            await userService.CreateUserAsync(userData.Email, userData.Name, userData.Role);
        }
    }
}